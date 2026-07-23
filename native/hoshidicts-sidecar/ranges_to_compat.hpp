#pragma once

#if defined(HAYASE_NEEDS_RANGES_TO_COMPAT)

#include <concepts>
#include <ranges>
#include <utility>

namespace std::ranges {

template <template <class...> class Container>
struct hayase_to_closure {};

template <input_range Range, template <class...> class Container>
auto operator|(Range&& range, hayase_to_closure<Container>) {
  using value_type = range_value_t<Range>;
  Container<value_type> result;

  if constexpr (sized_range<Range> &&
                requires { result.reserve(ranges::size(range)); }) {
    result.reserve(ranges::size(range));
  }

  for (auto&& value : range) {
    result.emplace_back(std::forward<decltype(value)>(value));
  }
  return result;
}

template <template <class...> class Container>
constexpr auto to() {
  return hayase_to_closure<Container>{};
}

}  // namespace std::ranges

#endif
