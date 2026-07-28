// SPDX-License-Identifier: GPL-3.0-only
//
// hoshidicts-sidecar - Hayase's NDJSON process boundary for hoshidicts.
// Copyright (C) 2026 Hayase contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, version 3 of the License.

#include <algorithm>
#include <atomic>
#include <cctype>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "glaze/json.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>
#endif

#include "hoshidicts/importer.hpp"
#include "hoshidicts/lookup.hpp"
#include "zip/zip.hpp"

namespace fs = std::filesystem;

namespace {

constexpr std::size_t kMaximumProtocolLine = 8 * 1024 * 1024;
constexpr int64_t kManifestSchemaVersion = 1;

fs::path path_from_utf8(std::string_view value) {
  return fs::path(
      std::u8string(reinterpret_cast<const char8_t *>(value.data()),
                    value.size()));
}

std::string path_to_utf8(const fs::path &path) {
  const auto value = path.u8string();
  return {reinterpret_cast<const char *>(value.data()), value.size()};
}

using Json = glz::generic_sorted_i64;
using JsonArray = Json::array_t;
using JsonObject = Json::object_t;

Json parse_json(std::string_view input) {
  Json result;
  if (auto error = glz::read_json(result, input)) {
    throw std::runtime_error(glz::format_error(error, input));
  }
  return result;
}

std::string stringify_json(const Json &value) {
  auto result = glz::write_json(value);
  if (!result) {
    throw std::runtime_error("could not serialize JSON");
  }
  return std::move(*result);
}

const Json *find_member(const Json &value, std::string_view name) {
  if (!value.is_object()) {
    return nullptr;
  }
  const auto &object = value.get_object();
  const auto found = object.find(name);
  return found == object.end() ? nullptr : &found->second;
}

class SidecarError : public std::runtime_error {
public:
  SidecarError(std::string code, std::string message)
      : std::runtime_error(std::move(message)), code_(std::move(code)) {}
  const std::string &code() const { return code_; }

private:
  std::string code_;
};

const JsonObject &require_object(const Json &value, std::string_view name) {
  if (!value.is_object()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be an object");
  }
  return value.get_object();
}

const Json &require_member(const JsonObject &object, std::string_view name) {
  auto it = object.find(std::string(name));
  if (it == object.end()) {
    throw SidecarError("INVALID_PARAMS",
                       "missing parameter: " + std::string(name));
  }
  return it->second;
}

std::string require_string(const JsonObject &object, std::string_view name) {
  const Json &value = require_member(object, name);
  if (!value.is_string()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be a string");
  }
  return value.get_string();
}

int64_t require_integer(const JsonObject &object, std::string_view name) {
  const Json &value = require_member(object, name);
  if (!value.is_int64()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be an integer");
  }
  return value.get<int64_t>();
}

bool optional_bool(const JsonObject &object, std::string_view name,
                   bool fallback) {
  auto it = object.find(std::string(name));
  if (it == object.end()) {
    return fallback;
  }
  if (!it->second.is_boolean()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be a boolean");
  }
  return it->second.get_boolean();
}

bool require_bool(const JsonObject &object, std::string_view name) {
  const Json &value = require_member(object, name);
  if (!value.is_boolean()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be a boolean");
  }
  return value.get_boolean();
}

std::vector<std::string> require_string_array(const JsonObject &object,
                                              std::string_view name) {
  const Json &value = require_member(object, name);
  if (!value.is_array()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be an array");
  }
  std::vector<std::string> result;
  result.reserve(value.get_array().size());
  for (const auto &item : value.get_array()) {
    if (!item.is_string()) {
      throw SidecarError("INVALID_PARAMS",
                         std::string(name) + " entries must be strings");
    }
    result.push_back(item.get_string());
  }
  return result;
}

Json string_array(const std::vector<std::string> &values) {
  JsonArray result;
  result.reserve(values.size());
  for (const auto &value : values) {
    result.emplace_back(value);
  }
  return result;
}

std::vector<std::string> split_whitespace(std::string_view input) {
  std::istringstream stream{std::string(input)};
  std::vector<std::string> result;
  std::string value;
  while (stream >> value) {
    result.push_back(std::move(value));
  }
  return result;
}

std::string read_file(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("could not read " + path_to_utf8(path));
  }
  return std::string(std::istreambuf_iterator<char>(input),
                     std::istreambuf_iterator<char>());
}

void write_atomic(const fs::path &path, std::string_view content) {
  fs::path temporary = path;
  temporary += ".tmp";
  {
    std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
    output.exceptions(std::ios::badbit | std::ios::failbit);
    output.write(content.data(), static_cast<std::streamsize>(content.size()));
    output.flush();
  }
#ifdef _WIN32
  if (!MoveFileExW(temporary.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    std::error_code ignored;
    fs::remove(temporary, ignored);
    throw std::runtime_error("could not replace " + path_to_utf8(path));
  }
#else
  if (::rename(temporary.c_str(), path.c_str()) != 0) {
    std::error_code ignored;
    fs::remove(temporary, ignored);
    throw std::runtime_error("could not replace " + path_to_utf8(path));
  }
#endif
}

uint64_t fnv1a(std::string_view input) {
  uint64_t hash = 14695981039346656037ull;
  for (unsigned char c : input) {
    hash ^= c;
    hash *= 1099511628211ull;
  }
  return hash;
}

std::string stable_id(std::string_view title) {
  std::ostringstream output;
  output << std::hex << std::setfill('0') << std::setw(16) << fnv1a(title);
  return output.str();
}

bool valid_dictionary_folder(const fs::path &path) {
  return fs::is_directory(path) && fs::is_regular_file(path / "index.json") &&
         fs::is_regular_file(path / "blobs.bin") &&
         fs::is_regular_file(path / "hash.table") &&
         fs::is_regular_file(path / "bloom.filter") &&
         (fs::is_regular_file(path / ".hoshidicts_3") ||
          fs::is_regular_file(path / ".hoshidicts_2") ||
          fs::is_regular_file(path / ".hoshidicts"));
}

struct Counts {
  uint64_t term = 0;
  uint64_t frequency = 0;
  uint64_t pitch = 0;
  uint64_t media = 0;
};

struct Enabled {
  bool term = false;
  bool frequency = false;
  bool pitch = false;
};

struct DictionaryRecord {
  std::string id;
  std::string title;
  std::string revision;
  int64_t format = 0;
  Counts counts;
  Enabled enabled;
  bool term_backed_pitch = false;
};

struct Orders {
  std::vector<std::string> term;
  std::vector<std::string> frequency;
  std::vector<std::string> pitch;
};

struct Manifest {
  int64_t schemaVersion = kManifestSchemaVersion;
  uint64_t generation = 0;
  std::vector<DictionaryRecord> dictionaries;
  Orders order;
};

Json counts_json(const Counts &counts) {
  return JsonObject{{"term", counts.term},
                      {"frequency", counts.frequency},
                      {"pitch", counts.pitch},
                      {"media", counts.media}};
}

Json enabled_json(const Enabled &enabled) {
  return JsonObject{{"term", enabled.term},
                      {"frequency", enabled.frequency},
                      {"pitch", enabled.pitch}};
}

Json dictionary_json(const DictionaryRecord &dictionary) {
  return JsonObject{{"id", dictionary.id},
                      {"title", dictionary.title},
                      {"revision", dictionary.revision},
                      {"format", dictionary.format},
                      {"counts", counts_json(dictionary.counts)},
                      {"enabled", enabled_json(dictionary.enabled)},
                      {"termBackedPitch", dictionary.term_backed_pitch}};
}

Json manifest_json(const Manifest &manifest) {
  JsonArray dictionaries;
  dictionaries.reserve(manifest.dictionaries.size());
  for (const auto &dictionary : manifest.dictionaries) {
    dictionaries.push_back(dictionary_json(dictionary));
  }
  return JsonObject{
      {"schemaVersion", manifest.schemaVersion},
      {"generation", manifest.generation},
      {"dictionaries", std::move(dictionaries)},
      {"order",
       JsonObject{{"term", string_array(manifest.order.term)},
                    {"frequency", string_array(manifest.order.frequency)},
                    {"pitch", string_array(manifest.order.pitch)}}}};
}

uint64_t optional_unsigned(const JsonObject &object, std::string_view name,
                           uint64_t fallback = 0) {
  auto it = object.find(std::string(name));
  if (it == object.end() || !it->second.is_int64() || it->second.get<int64_t>() < 0) {
    return fallback;
  }
  return static_cast<uint64_t>(it->second.get<int64_t>());
}

std::string optional_string(const JsonObject &object, std::string_view name,
                            std::string fallback = {}) {
  auto it = object.find(std::string(name));
  return it != object.end() && it->second.is_string() ? it->second.get_string()
                                                      : std::move(fallback);
}

bool optional_boolean(const JsonObject &object, std::string_view name,
                      bool fallback = false) {
  auto it = object.find(std::string(name));
  return it != object.end() && it->second.is_boolean() ? it->second.get_boolean()
                                                    : fallback;
}

Manifest parse_manifest(const Json &json) {
  const auto &root = require_object(json, "manifest");
  Manifest manifest;
  manifest.schemaVersion =
      static_cast<int64_t>(optional_unsigned(root, "schemaVersion", 0));
  if (manifest.schemaVersion != kManifestSchemaVersion) {
    throw std::runtime_error("unsupported manifest schema");
  }
  manifest.generation = optional_unsigned(root, "generation");

  const Json &dictionaries = require_member(root, "dictionaries");
  if (!dictionaries.is_array()) {
    throw std::runtime_error("manifest dictionaries must be an array");
  }
  for (const Json &value : dictionaries.get_array()) {
    const auto &item = require_object(value, "dictionary");
    DictionaryRecord dictionary;
    dictionary.id = require_string(item, "id");
    dictionary.title = require_string(item, "title");
    dictionary.revision = optional_string(item, "revision");
    dictionary.format = static_cast<int64_t>(optional_unsigned(item, "format"));
    if (const Json *counts = find_member(value, "counts");
        counts && counts->is_object()) {
      dictionary.counts.term = optional_unsigned(counts->get_object(), "term");
      dictionary.counts.frequency =
          optional_unsigned(counts->get_object(), "frequency");
      dictionary.counts.pitch = optional_unsigned(counts->get_object(), "pitch");
      dictionary.counts.media = optional_unsigned(counts->get_object(), "media");
    }
    if (const Json *enabled = find_member(value, "enabled");
        enabled && enabled->is_object()) {
      dictionary.enabled.term = optional_boolean(enabled->get_object(), "term");
      dictionary.enabled.frequency =
          optional_boolean(enabled->get_object(), "frequency");
      dictionary.enabled.pitch =
          optional_boolean(enabled->get_object(), "pitch");
    }
    dictionary.term_backed_pitch = optional_boolean(item, "termBackedPitch");
    manifest.dictionaries.push_back(std::move(dictionary));
  }

  const Json &order = require_member(root, "order");
  const auto &order_object = require_object(order, "manifest order");
  manifest.order.term = require_string_array(order_object, "term");
  manifest.order.frequency = require_string_array(order_object, "frequency");
  manifest.order.pitch = require_string_array(order_object, "pitch");
  return manifest;
}

DictionaryRecord parse_dictionary_record(const Json &value) {
  const auto &item = require_object(value, "dictionary");
  DictionaryRecord dictionary;
  dictionary.id = require_string(item, "id");
  dictionary.title = require_string(item, "title");
  dictionary.revision = optional_string(item, "revision");
  dictionary.format = static_cast<int64_t>(optional_unsigned(item, "format"));
  if (const Json *counts = find_member(value, "counts");
      counts && counts->is_object()) {
    dictionary.counts.term = optional_unsigned(counts->get_object(), "term");
    dictionary.counts.frequency =
        optional_unsigned(counts->get_object(), "frequency");
    dictionary.counts.pitch = optional_unsigned(counts->get_object(), "pitch");
    dictionary.counts.media = optional_unsigned(counts->get_object(), "media");
  }
  if (const Json *enabled = find_member(value, "enabled");
      enabled && enabled->is_object()) {
    dictionary.enabled.term = optional_boolean(enabled->get_object(), "term");
    dictionary.enabled.frequency =
        optional_boolean(enabled->get_object(), "frequency");
    dictionary.enabled.pitch = optional_boolean(enabled->get_object(), "pitch");
  }
  dictionary.term_backed_pitch = optional_boolean(item, "termBackedPitch");
  return dictionary;
}

struct IndexMetadata {
  std::string title;
  std::string revision;
  int64_t format = 0;
};

IndexMetadata read_index(const fs::path &dictionary_path) {
  Json index = parse_json(read_file(dictionary_path / "index.json"));
  const auto &object = require_object(index, "index.json");
  IndexMetadata metadata;
  metadata.title = require_string(object, "title");
  metadata.revision = optional_string(object, "revision");
  metadata.format = static_cast<int64_t>(optional_unsigned(object, "format"));
  if (metadata.format == 0) {
    metadata.format =
        static_cast<int64_t>(optional_unsigned(object, "version"));
  }
  if (metadata.title.empty()) {
    throw std::runtime_error("dictionary has an empty title");
  }
  return metadata;
}

bool safe_dictionary_title(std::string_view title) {
  return !title.empty() && title != "." && title != ".." &&
         title.find('/') == std::string_view::npos &&
         title.find('\\') == std::string_view::npos &&
         title.find('\0') == std::string_view::npos;
}

std::string preflight_dictionary_zip(const fs::path &zip_path) {
  Zip zip;
  if (!zip.open(zip_path)) {
    throw SidecarError("IMPORT_FAILED", "failed to open dictionary ZIP");
  }
  const int index_position = zip.find("index.json");
  if (index_position < 0) {
    throw SidecarError("IMPORT_FAILED", "dictionary ZIP is missing index.json");
  }
  const Json index = parse_json(zip.read(index_position));
  const std::string title =
      require_string(require_object(index, "index.json"), "title");
  if (!safe_dictionary_title(title)) {
    throw SidecarError("IMPORT_FAILED",
                       "dictionary title cannot be used as a directory name");
  }
  return title;
}

uint64_t summary_meta_count(const SummaryMetaCount &counts,
                            std::string_view kind) {
  const auto item = counts.find(std::string(kind));
  return item == counts.end() ? 0 : item->second;
}

std::vector<std::string> &order_for(Orders &orders, std::string_view kind) {
  if (kind == "term") {
    return orders.term;
  }
  if (kind == "frequency") {
    return orders.frequency;
  }
  if (kind == "pitch") {
    return orders.pitch;
  }
  throw SidecarError("INVALID_KIND", "kind must be term, frequency, or pitch");
}

const std::vector<std::string> &order_for(const Orders &orders,
                                          std::string_view kind) {
  return order_for(const_cast<Orders &>(orders), kind);
}

bool &enabled_for(Enabled &enabled, std::string_view kind) {
  if (kind == "term") {
    return enabled.term;
  }
  if (kind == "frequency") {
    return enabled.frequency;
  }
  if (kind == "pitch") {
    return enabled.pitch;
  }
  throw SidecarError("INVALID_KIND", "kind must be term, frequency, or pitch");
}

uint64_t count_for(const Counts &counts, std::string_view kind) {
  if (kind == "term") {
    return counts.term;
  }
  if (kind == "frequency") {
    return counts.frequency;
  }
  if (kind == "pitch") {
    return counts.pitch;
  }
  throw SidecarError("INVALID_KIND", "kind must be term, frequency, or pitch");
}

void normalize_order(Manifest &manifest, std::string_view kind) {
  auto &order = order_for(manifest.order, kind);
  std::vector<std::string> normalized;
  for (const auto &id : order) {
    auto found =
        std::ranges::find_if(manifest.dictionaries, [&](const auto &item) {
          return item.id == id && count_for(item.counts, kind) > 0;
        });
    if (found != manifest.dictionaries.end() &&
        std::ranges::find(normalized, id) == normalized.end()) {
      normalized.push_back(id);
    }
  }
  for (const auto &dictionary : manifest.dictionaries) {
    if (count_for(dictionary.counts, kind) > 0 &&
        std::ranges::find(normalized, dictionary.id) == normalized.end()) {
      normalized.push_back(dictionary.id);
    }
  }
  order = std::move(normalized);
}

struct QueryBundle {
  DictionaryQuery query;
  Deinflector deinflector;
  Lookup lookup;

  QueryBundle() : lookup(query, deinflector) {}
};

std::string base64_encode(const char *data, std::size_t size) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve(((size + 2) / 3) * 4);
  for (std::size_t offset = 0; offset < size; offset += 3) {
    const uint32_t first = static_cast<unsigned char>(data[offset]);
    const uint32_t second =
        offset + 1 < size ? static_cast<unsigned char>(data[offset + 1]) : 0;
    const uint32_t third =
        offset + 2 < size ? static_cast<unsigned char>(data[offset + 2]) : 0;
    const uint32_t value = (first << 16) | (second << 8) | third;
    output.push_back(alphabet[(value >> 18) & 0x3f]);
    output.push_back(alphabet[(value >> 12) & 0x3f]);
    output.push_back(offset + 1 < size ? alphabet[(value >> 6) & 0x3f] : '=');
    output.push_back(offset + 2 < size ? alphabet[value & 0x3f] : '=');
  }
  return output;
}

std::optional<std::size_t> utf8_offset_for_utf16(std::string_view text,
                                                 std::size_t target) {
  std::size_t byte = 0;
  std::size_t utf16 = 0;
  while (byte < text.size()) {
    if (utf16 == target) {
      return byte;
    }
    unsigned char lead = static_cast<unsigned char>(text[byte]);
    std::size_t width = 0;
    uint32_t codepoint = 0;
    if (lead <= 0x7f) {
      width = 1;
      codepoint = lead;
    } else if ((lead & 0xe0) == 0xc0) {
      width = 2;
      codepoint = lead & 0x1f;
    } else if ((lead & 0xf0) == 0xe0) {
      width = 3;
      codepoint = lead & 0x0f;
    } else if ((lead & 0xf8) == 0xf0) {
      width = 4;
      codepoint = lead & 0x07;
    } else {
      return std::nullopt;
    }
    if (byte + width > text.size()) {
      return std::nullopt;
    }
    for (std::size_t i = 1; i < width; ++i) {
      unsigned char continuation = static_cast<unsigned char>(text[byte + i]);
      if ((continuation & 0xc0) != 0x80) {
        return std::nullopt;
      }
      codepoint = (codepoint << 6) | (continuation & 0x3f);
    }
    std::size_t units = codepoint > 0xffff ? 2 : 1;
    if (utf16 + units > target) {
      return std::nullopt;
    }
    utf16 += units;
    byte += width;
  }
  return utf16 == target ? std::optional<std::size_t>(byte) : std::nullopt;
}

std::size_t utf16_length(std::string_view text) {
  std::size_t byte = 0;
  std::size_t result = 0;
  while (byte < text.size()) {
    unsigned char lead = static_cast<unsigned char>(text[byte]);
    std::size_t width =
        lead <= 0x7f
            ? 1
            : ((lead & 0xe0) == 0xc0 ? 2 : ((lead & 0xf0) == 0xe0 ? 3 : 4));
    result += width == 4 ? 2 : 1;
    byte += std::min(width, text.size() - byte);
  }
  return result;
}

Json lookup_entry_json(const LookupResult &result) {
  JsonArray trace;
  for (const auto &transform : result.trace) {
    trace.emplace_back(JsonObject{{"name", transform.name},
                                    {"description", transform.description}});
  }

  JsonArray glossaries;
  for (const auto &glossary : result.term.glossaries) {
    glossaries.emplace_back(JsonObject{
        {"dictionary", glossary.dict_name},
        {"content", glossary.glossary},
        {"definitionTags", glossary.definition_tags},
        {"termTags", glossary.term_tags},
    });
  }

  JsonArray frequencies;
  for (const auto &group : result.term.frequencies) {
    JsonArray values;
    for (const auto &frequency : group.frequencies) {
      values.emplace_back(
          JsonObject{{"value", frequency.value},
                       {"displayValue", frequency.display_value}});
    }
    frequencies.emplace_back(JsonObject{{"dictionary", group.dict_name},
                                          {"frequencies", std::move(values)}});
  }

  JsonArray pitches;
  for (const auto &group : result.term.pitches) {
    JsonArray positions;
    for (int position : group.pitch_positions) {
      positions.emplace_back(position);
    }
    pitches.emplace_back(
        JsonObject{{"dictionary", group.dict_name},
                     {"pitchPositions", std::move(positions)},
                     {"transcriptions", string_array(group.transcriptions)}});
  }

  return JsonObject{
      {"matched", result.matched},
      {"deinflected", result.deinflected},
      {"trace", std::move(trace)},
      {"expression", result.term.expression},
      {"reading", result.term.reading},
      {"rules", string_array(split_whitespace(result.term.rules))},
      {"glossaries", std::move(glossaries)},
      {"frequencies", std::move(frequencies)},
      {"pitches", std::move(pitches)},
  };
}

struct Command {
  int64_t id;
  std::string method;
  Json params;
  uint64_t sequence = 0;
};

class Sidecar {
public:
  explicit Sidecar(fs::path root)
      : root_(std::move(root)), data_(root_ / "data"),
        staging_(root_ / ".staging"), trash_(root_ / ".trash"),
        manifest_path_(root_ / "manifest.json") {
    initialize();
    lookup_thread_ = std::thread([this] { lookup_loop(); });
    admin_thread_ = std::thread([this] { admin_loop(); });
  }

  ~Sidecar() { stop(); }

  int run() {
    std::string line;
    while (!stopping_) {
      line.clear();
      bool received = false;
      bool oversized = false;
      char character = 0;
      while (std::cin.get(character)) {
        received = true;
        if (character == '\n') {
          break;
        }
        if (line.size() < kMaximumProtocolLine) {
          line.push_back(character);
        } else {
          oversized = true;
        }
      }
      if (!received) {
        break;
      }
      if (oversized) {
        send_error(0, "LINE_TOO_LARGE", "protocol line exceeds 8 MiB");
        continue;
      }
      Json request;
      try {
        request = parse_json(line);
        dispatch(request);
      } catch (const SidecarError &error) {
        send_error(request_id(request), error.code(), error.what());
      } catch (const std::exception &error) {
        send_error(request_id(request), "INVALID_REQUEST", error.what());
      }
    }
    stop();
    return 0;
  }

private:
  static int64_t request_id(const Json &request) {
    const Json *id = find_member(request, "id");
    return id && id->is_int64() && id->get<int64_t>() >= 0
               ? id->get<int64_t>()
               : 0;
  }

  void initialize() {
    fs::create_directories(root_);
    fs::create_directories(data_);
    fs::create_directories(staging_);
    fs::create_directories(trash_);

    for (const auto &entry : fs::directory_iterator(staging_)) {
      std::error_code error;
      fs::remove_all(entry.path(), error);
      if (error) {
        std::cerr << "could not clear stale staging path "
                  << path_to_utf8(entry.path())
                  << ": " << error.message() << '\n';
      }
    }
    for (const auto &entry : fs::directory_iterator(trash_)) {
      std::error_code error;
      fs::remove_all(entry.path(), error);
      if (error) {
        std::cerr << "could not clear stale trash path "
                  << path_to_utf8(entry.path()) << ": " << error.message()
                  << '\n';
      }
    }

    if (fs::is_regular_file(manifest_path_)) {
      try {
        manifest_ = parse_manifest(parse_json(read_file(manifest_path_)));
      } catch (const std::exception &error) {
        fs::path invalid = manifest_path_;
        invalid += ".invalid";
        std::error_code move_error;
        fs::rename(manifest_path_, invalid, move_error);
        std::cerr << "could not load manifest: " << error.what() << '\n';
        manifest_ = {};
      }
    }

    reconcile();
    normalize_order(manifest_, "term");
    normalize_order(manifest_, "frequency");
    normalize_order(manifest_, "pitch");
    save_manifest();
    bundle_ = build_bundle(manifest_);
  }

  void reconcile() {
    std::erase_if(manifest_.dictionaries, [&](const auto &dictionary) {
      return !valid_dictionary_folder(data_ / dictionary.id);
    });

    for (const auto &entry : fs::directory_iterator(data_)) {
      if (!entry.is_directory()) {
        continue;
      }
      std::string id = path_to_utf8(entry.path().filename());
      if (std::ranges::find(manifest_.dictionaries, id,
                            &DictionaryRecord::id) !=
          manifest_.dictionaries.end()) {
        continue;
      }
      if (!valid_dictionary_folder(entry.path())) {
        std::cerr << "leaving invalid dictionary folder untouched: "
                  << path_to_utf8(entry.path()) << '\n';
        continue;
      }
      try {
        DictionaryRecord dictionary;
        const fs::path metadata = entry.path() / ".sidecar.json";
        if (fs::is_regular_file(metadata)) {
          dictionary =
              parse_dictionary_record(parse_json(read_file(metadata)));
          dictionary.id = id;
        } else {
          IndexMetadata index = read_index(entry.path());
          dictionary = DictionaryRecord{
              .id = id,
              .title = std::move(index.title),
              .revision = std::move(index.revision),
              .format = index.format,
              // Older unmanaged folders do not retain import counts. Loading
              // them as term dictionaries is the only inference that does not
              // fabricate frequency or pitch UI entries.
              .counts = {.term = 1, .frequency = 0, .pitch = 0, .media = 0},
              .enabled = {.term = true, .frequency = false, .pitch = false},
          };
        }
        manifest_.dictionaries.push_back(std::move(dictionary));
      } catch (const std::exception &error) {
        std::cerr << "could not reconcile " << path_to_utf8(entry.path()) << ": "
                  << error.what() << '\n';
      }
    }
  }

  std::shared_ptr<QueryBundle> build_bundle(const Manifest &manifest) const {
    auto bundle = std::make_shared<QueryBundle>();
    auto add = [&](std::string_view kind,
                   const std::vector<std::string> &order) {
      for (const auto &id : order) {
        auto dictionary =
            std::ranges::find(manifest.dictionaries, id, &DictionaryRecord::id);
        if (dictionary == manifest.dictionaries.end() ||
            !enabled_for(const_cast<Enabled &>(dictionary->enabled), kind)) {
          continue;
        }
        fs::path path = data_ / id;
        if (kind == "term") {
          bundle->query.add_term_dict(path);
        } else if (kind == "frequency") {
          bundle->query.add_freq_dict(path);
        } else if (dictionary->term_backed_pitch) {
          bundle->query.add_term_dict(path);
        } else {
          bundle->query.add_pitch_dict(path);
        }
      }
    };
    add("term", manifest.order.term);
    add("frequency", manifest.order.frequency);
    add("pitch", manifest.order.pitch);
    return bundle;
  }

  void save_manifest(const Manifest &manifest) const {
    write_atomic(manifest_path_, stringify_json(manifest_json(manifest)));
  }

  void save_manifest() const { save_manifest(manifest_); }

  Json state_json() const {
    std::lock_guard lock(state_mutex_);
    JsonArray dictionaries;
    JsonObject styles;
    for (const auto &dictionary : manifest_.dictionaries) {
      dictionaries.push_back(dictionary_json(dictionary));
      fs::path stylesheet = data_ / dictionary.id / "styles.css";
      if (fs::is_regular_file(stylesheet)) {
        try {
          styles.insert_or_assign(dictionary.title, read_file(stylesheet));
        } catch (const std::exception &error) {
          std::cerr << "could not read dictionary stylesheet: " << error.what()
                    << '\n';
        }
      }
    }
    return JsonObject{
        {"available", true},
        {"generation", manifest_.generation},
        {"dictionaries", std::move(dictionaries)},
        {"order",
         JsonObject{{"term", string_array(manifest_.order.term)},
                      {"frequency", string_array(manifest_.order.frequency)},
                      {"pitch", string_array(manifest_.order.pitch)}}},
        {"styles", std::move(styles)},
    };
  }

  void dispatch(const Json &request) {
    const auto &object = require_object(request, "request");
    int64_t id = require_integer(object, "id");
    if (id < 0) {
      throw SidecarError("INVALID_REQUEST", "id must be non-negative");
    }
    std::string method = require_string(object, "method");
    Json params =
        object.contains("params") ? object.at("params") : Json(JsonObject{});
    require_object(params, "params");

    if (method == "hello") {
      send_result(
          id, JsonObject{
                  {"protocolVersion", 1},
                  {"backendVersion", "1.0.0"},
                  {"capabilities",
                   JsonArray{"lookup", "import", "term", "frequency", "pitch",
                               "media", "styles", "deinflection",
                               "supersession"}},
              });
    } else if (method == "state") {
      send_result(id, state_json());
    } else if (method == "lookup") {
      enqueue_lookup(Command{
          .id = id, .method = std::move(method), .params = std::move(params)});
    } else if (method == "media") {
      send_result(id, perform_media(params));
    } else if (method == "import" || method == "setEnabled" ||
               method == "reorder" || method == "remove") {
      {
        std::lock_guard lock(admin_mutex_);
        admin_queue_.push(Command{.id = id,
                                  .method = std::move(method),
                                  .params = std::move(params)});
      }
      admin_condition_.notify_one();
    } else if (method == "shutdown") {
      send_result(id, JsonObject{{"ok", true}});
      stopping_ = true;
      lookup_condition_.notify_all();
      admin_condition_.notify_all();
    } else {
      send_error(id, "METHOD_NOT_FOUND", "unknown method: " + method);
    }
  }

  void enqueue_lookup(Command command) {
    std::optional<int64_t> superseded;
    {
      std::lock_guard lock(lookup_mutex_);
      command.sequence = ++latest_lookup_sequence_;
      if (pending_lookup_) {
        superseded = pending_lookup_->id;
      }
      pending_lookup_ = std::move(command);
    }
    if (superseded) {
      send_error(*superseded, "SUPERSEDED",
                 "lookup was superseded by a newer request");
    }
    lookup_condition_.notify_one();
  }

  void lookup_loop() {
    while (true) {
      Command command;
      {
        std::unique_lock lock(lookup_mutex_);
        lookup_condition_.wait(
            lock, [&] { return stopping_ || pending_lookup_.has_value(); });
        if (stopping_ && !pending_lookup_) {
          return;
        }
        command = std::move(*pending_lookup_);
        pending_lookup_.reset();
        lookup_active_ = true;
      }

      try {
        Json result = perform_lookup(command.params, command.sequence);
        bool stale = false;
        {
          std::lock_guard lock(lookup_mutex_);
          stale = command.sequence != latest_lookup_sequence_.load();
        }
        if (stale) {
          send_error(command.id, "SUPERSEDED",
                     "lookup was superseded by a newer request");
        } else {
          send_result(command.id, std::move(result));
        }
      } catch (const SidecarError &error) {
        send_error(command.id, error.code(), error.what());
      } catch (const std::exception &error) {
        send_error(command.id, "LOOKUP_FAILED", error.what());
      }
      {
        std::lock_guard lock(lookup_mutex_);
        lookup_active_ = false;
      }
      lookup_idle_condition_.notify_all();
    }
  }

  Json perform_lookup(const Json &params, uint64_t sequence) {
    const auto &object = require_object(params, "lookup params");
    std::string text = require_string(object, "text");
    int64_t offset = require_integer(object, "offset");
    int64_t max_results = require_integer(object, "maxResults");
    int64_t scan_length = require_integer(object, "scanLength");
    if (offset < 0 || max_results < 1 || max_results > 256 || scan_length < 1 ||
        scan_length > 256) {
      throw SidecarError("INVALID_PARAMS", "lookup bounds are invalid");
    }
    auto byte_offset =
        utf8_offset_for_utf16(text, static_cast<std::size_t>(offset));
    if (!byte_offset) {
      throw SidecarError("INVALID_OFFSET",
                         "offset is not a UTF-16 character boundary");
    }

    std::shared_ptr<QueryBundle> bundle;
    {
      std::lock_guard lock(state_mutex_);
      bundle = bundle_;
    }
    auto results = bundle->lookup.lookup(
        text.substr(*byte_offset), static_cast<int>(max_results),
        static_cast<std::size_t>(scan_length), [this, sequence] {
          return stopping_ || sequence != latest_lookup_sequence_.load();
        });
    JsonArray entries;
    entries.reserve(results.size());
    std::size_t length = 0;
    for (const auto &result : results) {
      length = std::max(length, utf16_length(result.matched));
      entries.push_back(lookup_entry_json(result));
    }
    return JsonObject{{"length", static_cast<uint64_t>(length)},
                        {"entries", std::move(entries)}};
  }

  Json perform_media(const Json &params) {
    constexpr std::size_t maximum_media_size = 5 * 1024 * 1024;
    const auto &object = require_object(params, "media params");
    std::string dictionary = require_string(object, "dictionary");
    std::string path = require_string(object, "path");
    if (dictionary.empty() || dictionary.size() > 1024 || path.empty() ||
        path.size() > 4096) {
      throw SidecarError("INVALID_PARAMS",
                         "dictionary media identifiers are invalid");
    }

    std::shared_ptr<QueryBundle> bundle;
    {
      std::lock_guard lock(state_mutex_);
      bundle = bundle_;
    }
    auto media = bundle->query.get_media_file(dictionary, path);
    if (media.empty()) {
      throw SidecarError("MEDIA_NOT_FOUND", "dictionary media was not found");
    }
    if (media.size() > maximum_media_size) {
      throw SidecarError("MEDIA_TOO_LARGE",
                         "dictionary media exceeds the 5 MiB limit");
    }
    return JsonObject{
        {"data", base64_encode(media.data(), media.size())},
        {"size", static_cast<uint64_t>(media.size())},
    };
  }

  void admin_loop() {
    while (true) {
      Command command;
      {
        std::unique_lock lock(admin_mutex_);
        admin_condition_.wait(
            lock, [&] { return stopping_ || !admin_queue_.empty(); });
        if (stopping_ && admin_queue_.empty()) {
          return;
        }
        command = std::move(admin_queue_.front());
        admin_queue_.pop();
      }
      try {
        Json result;
        if (command.method == "import") {
          result = perform_import(command.params);
        } else if (command.method == "setEnabled") {
          result = perform_set_enabled(command.params);
        } else if (command.method == "reorder") {
          result = perform_reorder(command.params);
        } else {
          result = perform_remove(command.params);
        }
        send_event("stateChanged", result);
        send_result(command.id, std::move(result));
      } catch (const SidecarError &error) {
        send_error(command.id, error.code(), error.what());
      } catch (const std::exception &error) {
        send_error(command.id, "ADMIN_FAILED", error.what());
      }
    }
  }

  Json perform_import(const Json &params) {
    const auto &object = require_object(params, "import params");
    std::vector<std::string> paths = require_string_array(object, "paths");
    std::string operation_id = optional_string(object, "operationId");
    if (operation_id.empty()) {
      operation_id =
          "import-" +
          std::to_string(
              std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::system_clock::now().time_since_epoch())
                  .count());
    }
    bool low_ram = optional_bool(object, "lowRam", false);
    if (paths.empty()) {
      throw SidecarError("INVALID_PARAMS", "paths cannot be empty");
    }
    if (operation_id.empty() || operation_id.find('/') != std::string::npos ||
        operation_id.find('\\') != std::string::npos) {
      throw SidecarError("INVALID_PARAMS", "operationId is invalid");
    }

    struct Imported {
      DictionaryRecord record;
      fs::path staged;
      fs::path destination;
      std::size_t file_index = 0;
      std::string file_name;
    };
    std::vector<Imported> imports;
    fs::path operation_root = staging_ / operation_id;
    std::error_code cleanup_error;
    fs::remove_all(operation_root, cleanup_error);
    fs::create_directories(operation_root);

    try {
      for (std::size_t i = 0; i < paths.size(); ++i) {
        fs::path zip_path = path_from_utf8(paths[i]);
        fs::path work = operation_root / std::to_string(i);
        try {
          if (!fs::is_regular_file(zip_path)) {
            throw SidecarError("IMPORT_FAILED",
                               "dictionary ZIP does not exist");
          }
          fs::create_directories(work);
          const std::string file_name = path_to_utf8(zip_path.filename());
          auto progress = [this, &operation_id, &paths, i, &file_name](
                              std::string phase, uint64_t completed,
                              uint64_t total, std::string dictionary = {}) {
            JsonObject data{
                {"operationId", operation_id},
                {"fileIndex", static_cast<uint64_t>(i)},
                {"fileCount", static_cast<uint64_t>(paths.size())},
                {"fileName", file_name},
                {"phase", std::move(phase)},
                {"completed", completed},
                {"total", total}};
            if (!dictionary.empty()) {
              data.insert_or_assign("dictionary", std::move(dictionary));
            }
            send_event("importProgress", std::move(data));
          };
          progress("opening", 0, 1);
          const std::string source_title = preflight_dictionary_zip(zip_path);
          progress("opening", 1, 1, source_title);
          progress("importing", 0, 1, source_title);
          ImportResult result = dictionary_importer::import(
              zip_path, work, low_ram);
          if (!result.success) {
            std::string message = result.errors.empty()
                                      ? "dictionary import failed"
                                      : result.errors.front();
            throw SidecarError("IMPORT_FAILED", message);
          }
          progress("importing", 1, 1, result.title);
          progress("finalizing", 0, 1, result.title);
          if (result.title != source_title ||
              !safe_dictionary_title(result.title)) {
            throw SidecarError(
                "IMPORT_FAILED",
                "imported dictionary title did not match index.json");
          }
          fs::path staged = work / path_from_utf8(result.title);
          if (!valid_dictionary_folder(staged)) {
            throw SidecarError("IMPORT_FAILED",
                               "imported dictionary failed validation");
          }
          if (!result.summary.styles.empty()) {
            write_atomic(staged / "styles.css", result.summary.styles);
          }
          IndexMetadata index = read_index(staged);
          {
            std::lock_guard lock(state_mutex_);
            if (std::ranges::find(manifest_.dictionaries, index.title,
                                  &DictionaryRecord::title) !=
                manifest_.dictionaries.end()) {
              throw SidecarError("DUPLICATE_DICTIONARY",
                                 "dictionary is already installed: " +
                                     index.title);
            }
          }
          if (std::ranges::find(imports, index.title, [](const Imported &item) {
                return item.record.title;
              }) != imports.end()) {
            throw SidecarError("DUPLICATE_DICTIONARY",
                               "dictionary is duplicated in this import: " +
                                   index.title);
          }

          std::string lower_file_name = file_name;
          std::ranges::transform(lower_file_name, lower_file_name.begin(),
                                 [](unsigned char value) {
                                   return static_cast<char>(
                                       std::tolower(value));
                                 });
          const bool frequency_labeled = lower_file_name.starts_with("[freq]");
          const bool pitch_labeled = lower_file_name.starts_with("[pitch]");
          const uint64_t raw_terms = result.summary.counts.terms.total;
          const uint64_t frequencies =
              summary_meta_count(result.summary.counts.termMeta, "freq");
          const uint64_t metadata_pitches =
              summary_meta_count(result.summary.counts.termMeta, "pitch") +
              summary_meta_count(result.summary.counts.termMeta, "ipa");
          const bool term_backed_pitch =
              pitch_labeled && metadata_pitches == 0 && raw_terms > 0;
          const uint64_t terms =
              frequency_labeled || pitch_labeled ? 0 : raw_terms;
          const uint64_t pitches =
              term_backed_pitch ? raw_terms : metadata_pitches;
          if (terms == 0 && frequencies == 0 && pitches == 0) {
            throw SidecarError("UNSUPPORTED_DICTIONARY",
                               "dictionary contains no supported term, "
                               "frequency, or pitch data");
          }
          std::string id = stable_id(index.title);
          DictionaryRecord record{
              .id = id,
              .title = index.title,
              .revision = index.revision,
              .format = index.format,
              .counts =
                  {
                      .term = terms,
                      .frequency = frequencies,
                      .pitch = pitches,
                      .media = result.summary.counts.media.total,
                  },
              .enabled =
                  {
                      .term = terms > 0,
                      .frequency = frequencies > 0,
                      .pitch = pitches > 0,
                  },
              .term_backed_pitch = term_backed_pitch,
          };
          write_atomic(staged / ".sidecar.json",
                       stringify_json(dictionary_json(record)));
          progress("finalizing", 1, 1, index.title);
          imports.push_back(Imported{.record = std::move(record),
                                     .staged = std::move(staged),
                                     .destination = data_ / id,
                                     .file_index = i,
                                     .file_name = file_name});
        } catch (const SidecarError &error) {
          std::error_code ignored;
          fs::remove_all(work, ignored);
          send_event(
              "importError",
              JsonObject{{"operationId", operation_id},
                           {"fileIndex", static_cast<uint64_t>(i)},
                           {"fileCount", static_cast<uint64_t>(paths.size())},
                           {"fileName", path_to_utf8(zip_path.filename())},
                           {"code", error.code()},
                           {"message", error.what()}});
        } catch (const std::exception &error) {
          std::error_code ignored;
          fs::remove_all(work, ignored);
          send_event(
              "importError",
              JsonObject{{"operationId", operation_id},
                           {"fileIndex", static_cast<uint64_t>(i)},
                           {"fileCount", static_cast<uint64_t>(paths.size())},
                           {"fileName", path_to_utf8(zip_path.filename())},
                           {"code", "IMPORT_FAILED"},
                           {"message", error.what()}});
        }
      }

      if (imports.empty()) {
        fs::remove_all(operation_root, cleanup_error);
        return state_json();
      }

      std::vector<fs::path> moved;
      try {
        for (auto &imported : imports) {
          if (fs::exists(imported.destination)) {
            throw SidecarError("DUPLICATE_DICTIONARY",
                               "dictionary storage ID already exists");
          }
          fs::rename(imported.staged, imported.destination);
          moved.push_back(imported.destination);
        }
      } catch (...) {
        for (std::size_t i = 0; i < moved.size(); ++i) {
          std::error_code ignored;
          fs::rename(moved[i], imports[i].staged, ignored);
        }
        throw;
      }

      Manifest candidate;
      {
        std::lock_guard lock(state_mutex_);
        candidate = manifest_;
      }
      for (auto &imported : imports) {
        const auto &record = imported.record;
        candidate.dictionaries.push_back(record);
        if (record.counts.term > 0) {
          candidate.order.term.push_back(record.id);
        }
        if (record.counts.frequency > 0) {
          candidate.order.frequency.push_back(record.id);
        }
        if (record.counts.pitch > 0) {
          candidate.order.pitch.push_back(record.id);
        }
      }
      ++candidate.generation;
      try {
        auto next_bundle = build_bundle(candidate);
        save_manifest(candidate);
        std::lock_guard lock(state_mutex_);
        manifest_ = std::move(candidate);
        bundle_ = std::move(next_bundle);
      } catch (...) {
        for (auto &imported : imports) {
          std::error_code ignored;
          fs::rename(imported.destination, imported.staged, ignored);
        }
        throw;
      }
      for (const auto &imported : imports) {
        send_event(
            "importProgress",
            JsonObject{
                {"operationId", operation_id},
                {"fileIndex", static_cast<uint64_t>(imported.file_index)},
                {"fileCount", static_cast<uint64_t>(paths.size())},
                {"fileName", imported.file_name},
                {"dictionary", imported.record.title},
                {"phase", "completion"},
                {"completed", 1},
                {"total", 1}});
      }
      fs::remove_all(operation_root, cleanup_error);
      return state_json();
    } catch (...) {
      fs::remove_all(operation_root, cleanup_error);
      throw;
    }
  }

  static DictionaryRecord &find_dictionary(Manifest &manifest,
                                           std::string_view id) {
    auto dictionary =
        std::ranges::find(manifest.dictionaries, id, &DictionaryRecord::id);
    if (dictionary == manifest.dictionaries.end()) {
      throw SidecarError("DICTIONARY_NOT_FOUND", "dictionary is not installed");
    }
    return *dictionary;
  }

  Json perform_set_enabled(const Json &params) {
    const auto &object = require_object(params, "setEnabled params");
    std::string id = require_string(object, "id");
    std::string kind = require_string(object, "kind");
    bool enabled = require_bool(object, "enabled");
    Manifest candidate;
    {
      std::lock_guard lock(state_mutex_);
      candidate = manifest_;
    }
    DictionaryRecord &dictionary = find_dictionary(candidate, id);
    if (count_for(dictionary.counts, kind) == 0) {
      throw SidecarError("INVALID_KIND",
                         "dictionary does not contain " + kind + " data");
    }
    enabled_for(dictionary.enabled, kind) = enabled;
    ++candidate.generation;
    auto next_bundle = build_bundle(candidate);
    save_manifest(candidate);
    {
      std::lock_guard lock(state_mutex_);
      manifest_ = std::move(candidate);
      bundle_ = std::move(next_bundle);
    }
    return state_json();
  }

  Json perform_reorder(const Json &params) {
    const auto &object = require_object(params, "reorder params");
    std::string kind = require_string(object, "kind");
    std::vector<std::string> requested =
        object.contains("order") ? require_string_array(object, "order")
                                 : require_string_array(object, "ids");
    Manifest candidate;
    {
      std::lock_guard lock(state_mutex_);
      candidate = manifest_;
    }
    std::vector<std::string> expected;
    for (const auto &dictionary : candidate.dictionaries) {
      if (count_for(dictionary.counts, kind) > 0) {
        expected.push_back(dictionary.id);
      }
    }
    auto sorted_requested = requested;
    auto sorted_expected = expected;
    std::ranges::sort(sorted_requested);
    std::ranges::sort(sorted_expected);
    if (sorted_requested != sorted_expected ||
        std::ranges::adjacent_find(sorted_requested) !=
            sorted_requested.end()) {
      throw SidecarError(
          "INVALID_ORDER",
          "order must contain each dictionary of this kind exactly once");
    }
    order_for(candidate.order, kind) = std::move(requested);
    ++candidate.generation;
    auto next_bundle = build_bundle(candidate);
    save_manifest(candidate);
    {
      std::lock_guard lock(state_mutex_);
      manifest_ = std::move(candidate);
      bundle_ = std::move(next_bundle);
    }
    return state_json();
  }

  Json perform_remove(const Json &params) {
    const auto &object = require_object(params, "remove params");
    std::string id = require_string(object, "id");
    std::unique_lock lookup_lock(lookup_mutex_);
    lookup_idle_condition_.wait(lookup_lock, [&] { return !lookup_active_; });
    std::lock_guard lock(state_mutex_);
    find_dictionary(manifest_, id);
    fs::path source = data_ / id;
    auto stamp = std::chrono::duration_cast<std::chrono::milliseconds>(
                     std::chrono::system_clock::now().time_since_epoch())
                     .count();
    fs::path destination = trash_ / (id + "-" + std::to_string(stamp));

    Manifest previous = manifest_;
    std::erase_if(manifest_.dictionaries,
                  [&](const auto &item) { return item.id == id; });
    std::erase(manifest_.order.term, id);
    std::erase(manifest_.order.frequency, id);
    std::erase(manifest_.order.pitch, id);
    ++manifest_.generation;
    bool moved = false;
    try {
      auto next_bundle = build_bundle(manifest_);
      // No lookup is active and the lookup queue is gated above, so replacing
      // the final shared reference unmaps this dictionary before Windows moves
      // it.
      bundle_ = std::move(next_bundle);
      fs::rename(source, destination);
      moved = true;
      save_manifest();
    } catch (...) {
      manifest_ = std::move(previous);
      if (moved) {
        std::error_code ignored;
        fs::rename(destination, source, ignored);
      }
      bundle_ = build_bundle(manifest_);
      throw;
    }
    std::error_code cleanup_error;
    fs::remove_all(destination, cleanup_error);
    if (cleanup_error) {
      std::cerr << "could not delete removed dictionary "
                << path_to_utf8(destination) << ": " << cleanup_error.message()
                << '\n';
    }
    return state_json_unlocked();
  }

  Json state_json_unlocked() const {
    JsonArray dictionaries;
    JsonObject styles;
    for (const auto &dictionary : manifest_.dictionaries) {
      dictionaries.push_back(dictionary_json(dictionary));
      fs::path stylesheet = data_ / dictionary.id / "styles.css";
      if (fs::is_regular_file(stylesheet)) {
        try {
          styles.insert_or_assign(dictionary.title, read_file(stylesheet));
        } catch (...) {
        }
      }
    }
    return JsonObject{
        {"available", true},
        {"generation", manifest_.generation},
        {"dictionaries", std::move(dictionaries)},
        {"order",
         JsonObject{{"term", string_array(manifest_.order.term)},
                      {"frequency", string_array(manifest_.order.frequency)},
                      {"pitch", string_array(manifest_.order.pitch)}}},
        {"styles", std::move(styles)},
    };
  }

  void send_result(int64_t id, Json result) {
    std::string message = stringify_json(
        JsonObject{{"id", id}, {"result", std::move(result)}});
    if (message.size() > kMaximumProtocolLine) {
      send_error(id, "RESPONSE_TOO_LARGE",
                 "dictionary backend response exceeds 8 MiB");
      return;
    }
    send_serialized(std::move(message));
  }

  void send_error(int64_t id, std::string code, std::string message) {
    send(JsonObject{
        {"id", id},
        {"error", JsonObject{{"code", std::move(code)},
                               {"message", std::move(message)}}},
    });
  }

  void send_event(std::string event, Json data) {
    send(JsonObject{{"event", std::move(event)}, {"data", std::move(data)}});
  }

  void send(Json message) {
    send_serialized(stringify_json(message));
  }

  void send_serialized(std::string message) {
    std::lock_guard lock(output_mutex_);
    std::cout << message << '\n';
    std::cout.flush();
  }

  void stop() {
    bool was_stopping = stopping_.exchange(true);
    lookup_condition_.notify_all();
    admin_condition_.notify_all();
    if (!was_stopping) {
      std::optional<int64_t> pending;
      {
        std::lock_guard lock(lookup_mutex_);
        if (pending_lookup_) {
          pending = pending_lookup_->id;
          pending_lookup_.reset();
        }
      }
      if (pending) {
        send_error(*pending, "SHUTDOWN", "sidecar is shutting down");
      }
    }
    if (lookup_thread_.joinable()) {
      lookup_thread_.join();
    }
    if (admin_thread_.joinable()) {
      admin_thread_.join();
    }
  }

  fs::path root_;
  fs::path data_;
  fs::path staging_;
  fs::path trash_;
  fs::path manifest_path_;

  mutable std::mutex state_mutex_;
  Manifest manifest_;
  std::shared_ptr<QueryBundle> bundle_;

  std::atomic<bool> stopping_ = false;
  std::mutex output_mutex_;

  std::mutex lookup_mutex_;
  std::condition_variable lookup_condition_;
  std::condition_variable lookup_idle_condition_;
  std::optional<Command> pending_lookup_;
  bool lookup_active_ = false;
  std::atomic<uint64_t> latest_lookup_sequence_ = 0;
  std::thread lookup_thread_;

  std::mutex admin_mutex_;
  std::condition_variable admin_condition_;
  std::queue<Command> admin_queue_;
  std::thread admin_thread_;
};

void print_usage(std::string_view executable) {
  std::cerr << "Usage: " << executable << " --dictionary-root <path>\n";
}

int run_main(const std::vector<fs::path> &arguments) {
  try {
    fs::path dictionary_root;
    for (std::size_t i = 1; i < arguments.size(); ++i) {
      const std::string argument = path_to_utf8(arguments[i]);
      if (argument == "--dictionary-root" && i + 1 < arguments.size()) {
        dictionary_root = arguments[++i];
      } else {
        print_usage(path_to_utf8(arguments.front()));
        return 2;
      }
    }
    if (dictionary_root.empty()) {
      print_usage(path_to_utf8(arguments.front()));
      return 2;
    }
    return Sidecar(std::move(dictionary_root)).run();
  } catch (const std::exception &error) {
    std::cerr << "hoshidicts-sidecar fatal error: " << error.what() << '\n';
    return 1;
  }
}

} // namespace

int main(int argc, char *argv[]) {
#ifdef _WIN32
  int wide_argc = 0;
  wchar_t **wide_argv = CommandLineToArgvW(GetCommandLineW(), &wide_argc);
  if (!wide_argv) {
    std::cerr << "hoshidicts-sidecar fatal error: could not read command line\n";
    return 1;
  }
  std::vector<fs::path> arguments;
  arguments.reserve(static_cast<std::size_t>(wide_argc));
  for (int i = 0; i < wide_argc; ++i) {
    arguments.emplace_back(wide_argv[i]);
  }
  LocalFree(wide_argv);
  return run_main(arguments);
#else
  std::vector<fs::path> arguments;
  arguments.reserve(static_cast<std::size_t>(argc));
  for (int i = 0; i < argc; ++i) {
    arguments.emplace_back(argv[i]);
  }
  return run_main(arguments);
#endif
}
