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
#include <map>
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
#include <variant>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

#include "hoshidicts/importer.hpp"
#include "hoshidicts/lookup.hpp"
#include "zip/zip.hpp"

namespace fs = std::filesystem;

namespace {

constexpr std::size_t kMaximumProtocolLine = 8 * 1024 * 1024;
constexpr int64_t kManifestSchemaVersion = 1;

class Json {
public:
  using Array = std::vector<Json>;
  using Object = std::map<std::string, Json>;
  using Value = std::variant<std::nullptr_t, bool, int64_t, double, std::string,
                             Array, Object>;

  Json() : value_(nullptr) {}
  Json(std::nullptr_t) : value_(nullptr) {}
  Json(bool value) : value_(value) {}
  Json(int value) : value_(static_cast<int64_t>(value)) {}
  Json(int64_t value) : value_(value) {}
  Json(uint64_t value) : value_(static_cast<int64_t>(value)) {}
  Json(double value) : value_(value) {}
  Json(std::string value) : value_(std::move(value)) {}
  Json(const char *value) : value_(std::string(value)) {}
  Json(Array value) : value_(std::move(value)) {}
  Json(Object value) : value_(std::move(value)) {}

  bool is_null() const {
    return std::holds_alternative<std::nullptr_t>(value_);
  }
  bool is_bool() const { return std::holds_alternative<bool>(value_); }
  bool is_int() const { return std::holds_alternative<int64_t>(value_); }
  bool is_number() const {
    return is_int() || std::holds_alternative<double>(value_);
  }
  bool is_string() const { return std::holds_alternative<std::string>(value_); }
  bool is_array() const { return std::holds_alternative<Array>(value_); }
  bool is_object() const { return std::holds_alternative<Object>(value_); }

  bool as_bool() const { return std::get<bool>(value_); }
  int64_t as_int() const {
    if (is_int()) {
      return std::get<int64_t>(value_);
    }
    return static_cast<int64_t>(std::get<double>(value_));
  }
  const std::string &as_string() const { return std::get<std::string>(value_); }
  const Array &as_array() const { return std::get<Array>(value_); }
  Array &as_array() { return std::get<Array>(value_); }
  const Object &as_object() const { return std::get<Object>(value_); }
  Object &as_object() { return std::get<Object>(value_); }

  const Json *find(std::string_view key) const {
    if (!is_object()) {
      return nullptr;
    }
    auto it = as_object().find(std::string(key));
    return it == as_object().end() ? nullptr : &it->second;
  }

  static Json parse(std::string_view input) {
    Parser parser(input);
    Json result = parser.parse_value();
    parser.skip_whitespace();
    if (!parser.at_end()) {
      throw std::runtime_error("unexpected data after JSON value");
    }
    return result;
  }

  std::string stringify() const {
    std::string output;
    output.reserve(256);
    append_to(output);
    return output;
  }

private:
  class Parser {
  public:
    explicit Parser(std::string_view input) : input_(input) {}

    Json parse_value() {
      skip_whitespace();
      if (at_end()) {
        fail("expected JSON value");
      }
      switch (input_[position_]) {
      case 'n':
        consume_literal("null");
        return nullptr;
      case 't':
        consume_literal("true");
        return true;
      case 'f':
        consume_literal("false");
        return false;
      case '"':
        return parse_string();
      case '[':
        return parse_array();
      case '{':
        return parse_object();
      default:
        if (input_[position_] == '-' ||
            (input_[position_] >= '0' && input_[position_] <= '9')) {
          return parse_number();
        }
        fail("invalid JSON value");
      }
    }

    void skip_whitespace() {
      while (!at_end() &&
             (input_[position_] == ' ' || input_[position_] == '\t' ||
              input_[position_] == '\r' || input_[position_] == '\n')) {
        ++position_;
      }
    }

    bool at_end() const { return position_ >= input_.size(); }

  private:
    [[noreturn]] void fail(const std::string &message) const {
      throw std::runtime_error(message + " at byte " +
                               std::to_string(position_));
    }

    void consume_literal(std::string_view literal) {
      if (input_.substr(position_, literal.size()) != literal) {
        fail("invalid literal");
      }
      position_ += literal.size();
    }

    static void append_utf8(std::string &output, uint32_t codepoint) {
      if (codepoint <= 0x7f) {
        output.push_back(static_cast<char>(codepoint));
      } else if (codepoint <= 0x7ff) {
        output.push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
      } else if (codepoint <= 0xffff) {
        output.push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
      } else {
        output.push_back(static_cast<char>(0xf0 | (codepoint >> 18)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
      }
    }

    uint32_t parse_hex4() {
      if (position_ + 4 > input_.size()) {
        fail("incomplete unicode escape");
      }
      uint32_t value = 0;
      for (int i = 0; i < 4; ++i) {
        char c = input_[position_++];
        value <<= 4;
        if (c >= '0' && c <= '9') {
          value |= static_cast<uint32_t>(c - '0');
        } else if (c >= 'a' && c <= 'f') {
          value |= static_cast<uint32_t>(c - 'a' + 10);
        } else if (c >= 'A' && c <= 'F') {
          value |= static_cast<uint32_t>(c - 'A' + 10);
        } else {
          fail("invalid unicode escape");
        }
      }
      return value;
    }

    std::string parse_string() {
      if (input_[position_++] != '"') {
        fail("expected string");
      }
      std::string output;
      while (!at_end()) {
        unsigned char c = static_cast<unsigned char>(input_[position_++]);
        if (c == '"') {
          return output;
        }
        if (c < 0x20) {
          fail("unescaped control character");
        }
        if (c != '\\') {
          output.push_back(static_cast<char>(c));
          continue;
        }
        if (at_end()) {
          fail("incomplete escape");
        }
        char escaped = input_[position_++];
        switch (escaped) {
        case '"':
        case '\\':
        case '/':
          output.push_back(escaped);
          break;
        case 'b':
          output.push_back('\b');
          break;
        case 'f':
          output.push_back('\f');
          break;
        case 'n':
          output.push_back('\n');
          break;
        case 'r':
          output.push_back('\r');
          break;
        case 't':
          output.push_back('\t');
          break;
        case 'u': {
          uint32_t codepoint = parse_hex4();
          if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
            if (position_ + 2 > input_.size() || input_[position_] != '\\' ||
                input_[position_ + 1] != 'u') {
              fail("unpaired high surrogate");
            }
            position_ += 2;
            uint32_t low = parse_hex4();
            if (low < 0xdc00 || low > 0xdfff) {
              fail("invalid low surrogate");
            }
            codepoint = 0x10000 + ((codepoint - 0xd800) << 10) + (low - 0xdc00);
          } else if (codepoint >= 0xdc00 && codepoint <= 0xdfff) {
            fail("unpaired low surrogate");
          }
          append_utf8(output, codepoint);
          break;
        }
        default:
          fail("invalid escape");
        }
      }
      fail("unterminated string");
    }

    Json parse_array() {
      ++position_;
      Array result;
      skip_whitespace();
      if (!at_end() && input_[position_] == ']') {
        ++position_;
        return result;
      }
      while (true) {
        result.push_back(parse_value());
        skip_whitespace();
        if (at_end()) {
          fail("unterminated array");
        }
        char separator = input_[position_++];
        if (separator == ']') {
          return result;
        }
        if (separator != ',') {
          fail("expected array separator");
        }
      }
    }

    Json parse_object() {
      ++position_;
      Object result;
      skip_whitespace();
      if (!at_end() && input_[position_] == '}') {
        ++position_;
        return result;
      }
      while (true) {
        skip_whitespace();
        if (at_end() || input_[position_] != '"') {
          fail("expected object key");
        }
        std::string key = parse_string();
        skip_whitespace();
        if (at_end() || input_[position_++] != ':') {
          fail("expected colon");
        }
        result.insert_or_assign(std::move(key), parse_value());
        skip_whitespace();
        if (at_end()) {
          fail("unterminated object");
        }
        char separator = input_[position_++];
        if (separator == '}') {
          return result;
        }
        if (separator != ',') {
          fail("expected object separator");
        }
      }
    }

    Json parse_number() {
      const std::size_t start = position_;
      if (input_[position_] == '-') {
        ++position_;
      }
      if (at_end()) {
        fail("incomplete number");
      }
      if (input_[position_] == '0') {
        ++position_;
      } else {
        if (input_[position_] < '1' || input_[position_] > '9') {
          fail("invalid number");
        }
        while (!at_end() && input_[position_] >= '0' &&
               input_[position_] <= '9') {
          ++position_;
        }
      }
      bool floating = false;
      if (!at_end() && input_[position_] == '.') {
        floating = true;
        ++position_;
        if (at_end() || input_[position_] < '0' || input_[position_] > '9') {
          fail("invalid fraction");
        }
        while (!at_end() && input_[position_] >= '0' &&
               input_[position_] <= '9') {
          ++position_;
        }
      }
      if (!at_end() && (input_[position_] == 'e' || input_[position_] == 'E')) {
        floating = true;
        ++position_;
        if (!at_end() &&
            (input_[position_] == '+' || input_[position_] == '-')) {
          ++position_;
        }
        if (at_end() || input_[position_] < '0' || input_[position_] > '9') {
          fail("invalid exponent");
        }
        while (!at_end() && input_[position_] >= '0' &&
               input_[position_] <= '9') {
          ++position_;
        }
      }
      std::string_view number = input_.substr(start, position_ - start);
      if (!floating) {
        int64_t integer = 0;
        auto [end, error] = std::from_chars(
            number.data(), number.data() + number.size(), integer);
        if (error == std::errc{} && end == number.data() + number.size()) {
          return integer;
        }
      }
      std::string copy(number);
      char *end = nullptr;
      double value = std::strtod(copy.c_str(), &end);
      if (!end || end != copy.c_str() + copy.size()) {
        fail("invalid number");
      }
      return value;
    }

    std::string_view input_;
    std::size_t position_ = 0;
  };

  static void append_escaped(std::string &output, std::string_view value) {
    static constexpr char hex[] = "0123456789abcdef";
    output.push_back('"');
    for (unsigned char c : value) {
      switch (c) {
      case '"':
        output += "\\\"";
        break;
      case '\\':
        output += "\\\\";
        break;
      case '\b':
        output += "\\b";
        break;
      case '\f':
        output += "\\f";
        break;
      case '\n':
        output += "\\n";
        break;
      case '\r':
        output += "\\r";
        break;
      case '\t':
        output += "\\t";
        break;
      default:
        if (c < 0x20) {
          output += "\\u00";
          output.push_back(hex[(c >> 4) & 0xf]);
          output.push_back(hex[c & 0xf]);
        } else {
          output.push_back(static_cast<char>(c));
        }
      }
    }
    output.push_back('"');
  }

  void append_to(std::string &output) const {
    if (is_null()) {
      output += "null";
    } else if (is_bool()) {
      output += as_bool() ? "true" : "false";
    } else if (is_int()) {
      output += std::to_string(as_int());
    } else if (std::holds_alternative<double>(value_)) {
      std::ostringstream stream;
      stream << std::setprecision(17) << std::get<double>(value_);
      output += stream.str();
    } else if (is_string()) {
      append_escaped(output, as_string());
    } else if (is_array()) {
      output.push_back('[');
      bool first = true;
      for (const auto &value : as_array()) {
        if (!first) {
          output.push_back(',');
        }
        first = false;
        value.append_to(output);
      }
      output.push_back(']');
    } else {
      output.push_back('{');
      bool first = true;
      for (const auto &[key, value] : as_object()) {
        if (!first) {
          output.push_back(',');
        }
        first = false;
        append_escaped(output, key);
        output.push_back(':');
        value.append_to(output);
      }
      output.push_back('}');
    }
  }

  Value value_;
};

class SidecarError : public std::runtime_error {
public:
  SidecarError(std::string code, std::string message)
      : std::runtime_error(std::move(message)), code_(std::move(code)) {}
  const std::string &code() const { return code_; }

private:
  std::string code_;
};

const Json::Object &require_object(const Json &value, std::string_view name) {
  if (!value.is_object()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be an object");
  }
  return value.as_object();
}

const Json &require_member(const Json::Object &object, std::string_view name) {
  auto it = object.find(std::string(name));
  if (it == object.end()) {
    throw SidecarError("INVALID_PARAMS",
                       "missing parameter: " + std::string(name));
  }
  return it->second;
}

std::string require_string(const Json::Object &object, std::string_view name) {
  const Json &value = require_member(object, name);
  if (!value.is_string()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be a string");
  }
  return value.as_string();
}

int64_t require_integer(const Json::Object &object, std::string_view name) {
  const Json &value = require_member(object, name);
  if (!value.is_int()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be an integer");
  }
  return value.as_int();
}

bool optional_bool(const Json::Object &object, std::string_view name,
                   bool fallback) {
  auto it = object.find(std::string(name));
  if (it == object.end()) {
    return fallback;
  }
  if (!it->second.is_bool()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be a boolean");
  }
  return it->second.as_bool();
}

bool require_bool(const Json::Object &object, std::string_view name) {
  const Json &value = require_member(object, name);
  if (!value.is_bool()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be a boolean");
  }
  return value.as_bool();
}

std::vector<std::string> require_string_array(const Json::Object &object,
                                              std::string_view name) {
  const Json &value = require_member(object, name);
  if (!value.is_array()) {
    throw SidecarError("INVALID_PARAMS",
                       std::string(name) + " must be an array");
  }
  std::vector<std::string> result;
  result.reserve(value.as_array().size());
  for (const auto &item : value.as_array()) {
    if (!item.is_string()) {
      throw SidecarError("INVALID_PARAMS",
                         std::string(name) + " entries must be strings");
    }
    result.push_back(item.as_string());
  }
  return result;
}

Json string_array(const std::vector<std::string> &values) {
  Json::Array result;
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
    throw std::runtime_error("could not read " + path.string());
  }
  return std::string(std::istreambuf_iterator<char>(input),
                     std::istreambuf_iterator<char>());
}

void write_atomic(const fs::path &path, std::string_view content) {
  const fs::path temporary = path.string() + ".tmp";
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
    throw std::runtime_error("could not replace " + path.string());
  }
#else
  if (::rename(temporary.c_str(), path.c_str()) != 0) {
    std::error_code ignored;
    fs::remove(temporary, ignored);
    throw std::runtime_error("could not replace " + path.string());
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
  return Json::Object{{"term", counts.term},
                      {"frequency", counts.frequency},
                      {"pitch", counts.pitch},
                      {"media", counts.media}};
}

Json enabled_json(const Enabled &enabled) {
  return Json::Object{{"term", enabled.term},
                      {"frequency", enabled.frequency},
                      {"pitch", enabled.pitch}};
}

Json dictionary_json(const DictionaryRecord &dictionary) {
  return Json::Object{{"id", dictionary.id},
                      {"title", dictionary.title},
                      {"revision", dictionary.revision},
                      {"format", dictionary.format},
                      {"counts", counts_json(dictionary.counts)},
                      {"enabled", enabled_json(dictionary.enabled)},
                      {"termBackedPitch", dictionary.term_backed_pitch}};
}

Json manifest_json(const Manifest &manifest) {
  Json::Array dictionaries;
  dictionaries.reserve(manifest.dictionaries.size());
  for (const auto &dictionary : manifest.dictionaries) {
    dictionaries.push_back(dictionary_json(dictionary));
  }
  return Json::Object{
      {"schemaVersion", manifest.schemaVersion},
      {"generation", manifest.generation},
      {"dictionaries", std::move(dictionaries)},
      {"order",
       Json::Object{{"term", string_array(manifest.order.term)},
                    {"frequency", string_array(manifest.order.frequency)},
                    {"pitch", string_array(manifest.order.pitch)}}}};
}

uint64_t optional_unsigned(const Json::Object &object, std::string_view name,
                           uint64_t fallback = 0) {
  auto it = object.find(std::string(name));
  if (it == object.end() || !it->second.is_int() || it->second.as_int() < 0) {
    return fallback;
  }
  return static_cast<uint64_t>(it->second.as_int());
}

std::string optional_string(const Json::Object &object, std::string_view name,
                            std::string fallback = {}) {
  auto it = object.find(std::string(name));
  return it != object.end() && it->second.is_string() ? it->second.as_string()
                                                      : std::move(fallback);
}

bool optional_boolean(const Json::Object &object, std::string_view name,
                      bool fallback = false) {
  auto it = object.find(std::string(name));
  return it != object.end() && it->second.is_bool() ? it->second.as_bool()
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
  for (const Json &value : dictionaries.as_array()) {
    const auto &item = require_object(value, "dictionary");
    DictionaryRecord dictionary;
    dictionary.id = require_string(item, "id");
    dictionary.title = require_string(item, "title");
    dictionary.revision = optional_string(item, "revision");
    dictionary.format = static_cast<int64_t>(optional_unsigned(item, "format"));
    if (const Json *counts = value.find("counts");
        counts && counts->is_object()) {
      dictionary.counts.term = optional_unsigned(counts->as_object(), "term");
      dictionary.counts.frequency =
          optional_unsigned(counts->as_object(), "frequency");
      dictionary.counts.pitch = optional_unsigned(counts->as_object(), "pitch");
      dictionary.counts.media = optional_unsigned(counts->as_object(), "media");
    }
    if (const Json *enabled = value.find("enabled");
        enabled && enabled->is_object()) {
      dictionary.enabled.term = optional_boolean(enabled->as_object(), "term");
      dictionary.enabled.frequency =
          optional_boolean(enabled->as_object(), "frequency");
      dictionary.enabled.pitch =
          optional_boolean(enabled->as_object(), "pitch");
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
  if (const Json *counts = value.find("counts");
      counts && counts->is_object()) {
    dictionary.counts.term = optional_unsigned(counts->as_object(), "term");
    dictionary.counts.frequency =
        optional_unsigned(counts->as_object(), "frequency");
    dictionary.counts.pitch = optional_unsigned(counts->as_object(), "pitch");
    dictionary.counts.media = optional_unsigned(counts->as_object(), "media");
  }
  if (const Json *enabled = value.find("enabled");
      enabled && enabled->is_object()) {
    dictionary.enabled.term = optional_boolean(enabled->as_object(), "term");
    dictionary.enabled.frequency =
        optional_boolean(enabled->as_object(), "frequency");
    dictionary.enabled.pitch = optional_boolean(enabled->as_object(), "pitch");
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
  Json index = Json::parse(read_file(dictionary_path / "index.json"));
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
  if (!zip.open(zip_path.string())) {
    throw SidecarError("IMPORT_FAILED", "failed to open dictionary ZIP");
  }
  const int index_position = zip.find("index.json");
  if (index_position < 0) {
    throw SidecarError("IMPORT_FAILED", "dictionary ZIP is missing index.json");
  }
  const Json index = Json::parse(zip.read(index_position));
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
  Json::Array trace;
  for (const auto &transform : result.trace) {
    trace.emplace_back(Json::Object{{"name", transform.name},
                                    {"description", transform.description}});
  }

  Json::Array glossaries;
  for (const auto &glossary : result.term.glossaries) {
    glossaries.emplace_back(Json::Object{
        {"dictionary", glossary.dict_name},
        {"content", glossary.glossary},
        {"definitionTags", glossary.definition_tags},
        {"termTags", glossary.term_tags},
    });
  }

  Json::Array frequencies;
  for (const auto &group : result.term.frequencies) {
    Json::Array values;
    for (const auto &frequency : group.frequencies) {
      values.emplace_back(
          Json::Object{{"value", frequency.value},
                       {"displayValue", frequency.display_value}});
    }
    frequencies.emplace_back(Json::Object{{"dictionary", group.dict_name},
                                          {"frequencies", std::move(values)}});
  }

  Json::Array pitches;
  for (const auto &group : result.term.pitches) {
    Json::Array positions;
    for (int position : group.pitch_positions) {
      positions.emplace_back(position);
    }
    pitches.emplace_back(
        Json::Object{{"dictionary", group.dict_name},
                     {"pitchPositions", std::move(positions)},
                     {"transcriptions", string_array(group.transcriptions)}});
  }

  return Json::Object{
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
        request = Json::parse(line);
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
    const Json *id = request.find("id");
    return id && id->is_int() && id->as_int() >= 0 ? id->as_int() : 0;
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
        std::cerr << "could not clear stale staging path " << entry.path()
                  << ": " << error.message() << '\n';
      }
    }

    if (fs::is_regular_file(manifest_path_)) {
      try {
        manifest_ = parse_manifest(Json::parse(read_file(manifest_path_)));
      } catch (const std::exception &error) {
        const fs::path invalid = manifest_path_.string() + ".invalid";
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
      std::string id = entry.path().filename().string();
      if (std::ranges::find(manifest_.dictionaries, id,
                            &DictionaryRecord::id) !=
          manifest_.dictionaries.end()) {
        continue;
      }
      if (!valid_dictionary_folder(entry.path())) {
        std::cerr << "leaving invalid dictionary folder untouched: "
                  << entry.path() << '\n';
        continue;
      }
      try {
        DictionaryRecord dictionary;
        const fs::path metadata = entry.path() / ".sidecar.json";
        if (fs::is_regular_file(metadata)) {
          dictionary =
              parse_dictionary_record(Json::parse(read_file(metadata)));
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
        std::cerr << "could not reconcile " << entry.path() << ": "
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
        std::string path = (data_ / id).string();
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
    write_atomic(manifest_path_, manifest_json(manifest).stringify());
  }

  void save_manifest() const { save_manifest(manifest_); }

  Json state_json() const {
    std::lock_guard lock(state_mutex_);
    Json::Array dictionaries;
    Json::Object styles;
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
    return Json::Object{
        {"available", true},
        {"generation", manifest_.generation},
        {"dictionaries", std::move(dictionaries)},
        {"order",
         Json::Object{{"term", string_array(manifest_.order.term)},
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
        object.contains("params") ? object.at("params") : Json(Json::Object{});
    require_object(params, "params");

    if (method == "hello") {
      send_result(
          id, Json::Object{
                  {"protocolVersion", 1},
                  {"backendVersion", "1.0.0"},
                  {"capabilities",
                   Json::Array{"lookup", "import", "term", "frequency", "pitch",
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
      send_result(id, Json::Object{{"ok", true}});
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
        Json result = perform_lookup(command.params);
        bool stale = false;
        {
          std::lock_guard lock(lookup_mutex_);
          stale = command.sequence != latest_lookup_sequence_;
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

  Json perform_lookup(const Json &params) {
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
    auto results = bundle->lookup.lookup(text.substr(*byte_offset),
                                         static_cast<int>(max_results),
                                         static_cast<std::size_t>(scan_length));
    Json::Array entries;
    entries.reserve(results.size());
    std::size_t length = 0;
    for (const auto &result : results) {
      length = std::max(length, utf16_length(result.matched));
      entries.push_back(lookup_entry_json(result));
    }
    return Json::Object{{"length", static_cast<uint64_t>(length)},
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
    return Json::Object{
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
        fs::path zip_path = paths[i];
        fs::path work = operation_root / std::to_string(i);
        try {
          if (!fs::is_regular_file(zip_path)) {
            throw SidecarError("IMPORT_FAILED",
                               "dictionary ZIP does not exist");
          }
          fs::create_directories(work);
          const std::string file_name = zip_path.filename().string();
          auto progress = [this, &operation_id, &paths, i, &file_name](
                              std::string phase, uint64_t completed,
                              uint64_t total, std::string dictionary = {}) {
            Json::Object data{
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
              zip_path.string(), work.string(), low_ram);
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
          fs::path staged = work / result.title;
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
                       dictionary_json(record).stringify());
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
              Json::Object{{"operationId", operation_id},
                           {"fileIndex", static_cast<uint64_t>(i)},
                           {"fileCount", static_cast<uint64_t>(paths.size())},
                           {"fileName", zip_path.filename().string()},
                           {"code", error.code()},
                           {"message", error.what()}});
        } catch (const std::exception &error) {
          std::error_code ignored;
          fs::remove_all(work, ignored);
          send_event(
              "importError",
              Json::Object{{"operationId", operation_id},
                           {"fileIndex", static_cast<uint64_t>(i)},
                           {"fileCount", static_cast<uint64_t>(paths.size())},
                           {"fileName", zip_path.filename().string()},
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
            Json::Object{
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
    return state_json_unlocked();
  }

  Json state_json_unlocked() const {
    Json::Array dictionaries;
    Json::Object styles;
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
    return Json::Object{
        {"available", true},
        {"generation", manifest_.generation},
        {"dictionaries", std::move(dictionaries)},
        {"order",
         Json::Object{{"term", string_array(manifest_.order.term)},
                      {"frequency", string_array(manifest_.order.frequency)},
                      {"pitch", string_array(manifest_.order.pitch)}}},
        {"styles", std::move(styles)},
    };
  }

  void send_result(int64_t id, Json result) {
    send(Json::Object{{"id", id}, {"result", std::move(result)}});
  }

  void send_error(int64_t id, std::string code, std::string message) {
    send(Json::Object{
        {"id", id},
        {"error", Json::Object{{"code", std::move(code)},
                               {"message", std::move(message)}}},
    });
  }

  void send_event(std::string event, Json data) {
    send(Json::Object{{"event", std::move(event)}, {"data", std::move(data)}});
  }

  void send(Json message) {
    std::lock_guard lock(output_mutex_);
    std::cout << message.stringify() << '\n';
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
  uint64_t latest_lookup_sequence_ = 0;
  std::thread lookup_thread_;

  std::mutex admin_mutex_;
  std::condition_variable admin_condition_;
  std::queue<Command> admin_queue_;
  std::thread admin_thread_;
};

void print_usage(const char *executable) {
  std::cerr << "Usage: " << executable << " --dictionary-root <path>\n";
}

} // namespace

int main(int argc, char *argv[]) {
  try {
    fs::path dictionary_root;
    for (int i = 1; i < argc; ++i) {
      std::string_view argument = argv[i];
      if (argument == "--dictionary-root" && i + 1 < argc) {
        dictionary_root = argv[++i];
      } else {
        print_usage(argv[0]);
        return 2;
      }
    }
    if (dictionary_root.empty()) {
      print_usage(argv[0]);
      return 2;
    }
    return Sidecar(std::move(dictionary_root)).run();
  } catch (const std::exception &error) {
    std::cerr << "hoshidicts-sidecar fatal error: " << error.what() << '\n';
    return 1;
  }
}
