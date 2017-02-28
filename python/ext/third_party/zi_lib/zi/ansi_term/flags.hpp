//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_ANSI_TERM_FLAGS_HPP
#define ZI_ANSI_TERM_FLAGS_HPP 1

#include <zi/config/config.hpp>
#include <zi/ansi_term/tags.hpp>

#include <zi/bits/cstdint.hpp>
#include <iostream>

namespace zi {
namespace tos {
namespace detail {

struct flags {
public:

    static const uint16_t FG_COLOR_MASK    = 0x001F;
    static const uint16_t BG_COLOR_MASK    = 0x03E0;
    static const uint16_t COLOR_MASK       = 0x03FF;

    static const uint16_t WEIGHT_MASK      = 0x0C00; // 0000 xx00 0000 0000
    static const uint16_t UNDERLINE_MASK   = 0x1000; // 000x 0000 0000 0000
    static const uint16_t OVERLINE_MASK    = 0x2000; // 00x0 0000 0000 0000
    static const uint16_t INVERTED_MASK    = 0x4000; // 0x00 0000 0000 0000
    static const uint16_t DECORATION_MASK  = 0x7000; // 0x00 0000 0000 0000
    static const uint16_t DIRTY_MASK       = 0x8000; // 0x00 0000 0000 0000

    static const uint16_t COLOR_OFFSET     = 0  ;
    static const uint16_t FG_COLOR_OFFSET  = 0  ;
    static const uint16_t BG_COLOR_OFFSET  = 5  ;
    static const uint16_t WEIGHT_OFFSET    = 10 ;
    static const uint16_t UNDERLINE_OFFSET = 12 ;
    static const uint16_t OVERLINE_OFFSET  = 13 ;
    static const uint16_t INVERTED_OFFSET  = 14 ;

    static const uint16_t DEFAULT          = 0x0000;

private:
    uint16_t value_;

public:

    flags(uint16_t value = DEFAULT): value_(value) {}
    flags(const flags& f): value_(f.value_) {}

    inline bool customized() const
    {
        return value_ != 0;
    }

    inline void set_color(uint16_t color)
    {
        value_ &= ~FG_COLOR_MASK;
        value_ |= ((color & FG_COLOR_MASK) << FG_COLOR_OFFSET);
        value_ |= DIRTY_MASK;
    }

    inline void set_bg_color(uint16_t color)
    {
        value_ &= ~BG_COLOR_MASK;
        value_ |= ((color & COLOR_MASK) << BG_COLOR_OFFSET);
        value_ |= DIRTY_MASK;

    }

    inline void set_weight(uint16_t w)
    {
        value_ &= ~WEIGHT_MASK;
        value_ |= (w & WEIGHT_MASK);
        value_ |= DIRTY_MASK;
    }

    inline void add_decoration(uint16_t w)
    {
        value_ |= DECORATION_MASK & w;
        value_ |= DIRTY_MASK;
        value_ |= DIRTY_MASK;
    }

    inline void remove_decoration(uint16_t w)
    {
        value_ |= ~(DECORATION_MASK & w);
        value_ |= DIRTY_MASK;
    }

    inline void set_decoration(uint16_t w)
    {
        value_ &= ~DECORATION_MASK;
        value_ |= DECORATION_MASK & w;
        value_ |= DIRTY_MASK;
    }

    static inline void apply_flags(std::ostream &out, uint16_t value)
    {

        static const uint16_t WEIGHT[4] = { 21, 2, 1, 21 };

        static const uint16_t COLORS[32] = {
            39, 39, 39, 39, 39, 39, 39, 39,
            30, 31, 32, 33, 34, 35, 36, 37,
            39, 39, 39, 39, 39, 39, 39, 39,
            90, 91, 92, 93, 94, 95, 96, 97
        };

        if (value == DEFAULT) {

            out << "\033[0m";

        } else {

            if (value & WEIGHT_MASK)
                out << "\033["
                    << WEIGHT[(value & WEIGHT_MASK) >> WEIGHT_OFFSET] << "m";

            if (value & UNDERLINE_MASK)
                out << "\033[" << (value & UNDERLINE_MASK ? 4 : 24) << "m";

            if (value & OVERLINE_MASK)
                out << "\033[" << (value & OVERLINE_MASK ? 9 : 29) << "m";

            if (value & INVERTED_MASK)
                out << "\033[" << (value & INVERTED_MASK ? 7 : 27) << "m";

            if (value & FG_COLOR_MASK)
                out << "\033[" << COLORS[value & FG_COLOR_MASK] << "m";

            if (value & BG_COLOR_MASK)
                out << "\033["
                    << COLORS[(value & BG_COLOR_MASK) >> BG_COLOR_OFFSET] + 10 << "m";
        }
    }

    inline void apply(std::ostream &out) const
    {
        apply_flags(out, value_);
    }

    inline void apply_clear(std::ostream &out) const
    {
        apply_flags(out, DEFAULT);
    }

    inline bool dirty() const
    {
        return ( value_ & DIRTY_MASK ) != 0;
    }

    inline void clear()
    {
        value_ &= ~DIRTY_MASK;
    }

};

inline std::ostream& operator<< (std::ostream &out, const flags &f)
{
    f.apply(out);
    return out;
};

template<typename T = void> struct flags_diff;

template<> struct flags_diff<fg_color_tag>
           {
               const uint16_t color_;
               flags_diff(color_constants color): color_((uint16_t) color) {}
               void operator() (flags &f) const { f.set_color(color_); }
};

template<> struct flags_diff<bg_color_tag>
{
    const uint16_t color_;
    flags_diff(color_constants color): color_((uint16_t) color) {}
    void operator() (flags &f) const { f.set_bg_color(color_); }
};

template<> struct flags_diff<color_pair_tag>
{
    const uint16_t fg_, bg_;
    flags_diff(color_constants fg, color_constants bg): fg_(fg), bg_(bg) {}
    void operator() (flags &f) const { f.set_color(fg_); f.set_bg_color(bg_); }
};

template<> struct flags_diff<weight_tag>
{
    const uint16_t weight_;
    flags_diff(weight_constants weight): weight_((uint16_t)weight) {}
    void operator() (flags &f) const { f.set_weight(weight_); }
};

template<> struct flags_diff<decoration_tag>
{
    const uint16_t decor_;
    flags_diff(decoration_constants decor): decor_((uint16_t)decor) {}
    void operator() (flags &f) const { f.set_decoration(decor_); }
};

typedef flags_diff< fg_color_tag >   foreground;
typedef flags_diff< bg_color_tag >   background;
typedef flags_diff< color_pair_tag > colors    ;
typedef flags_diff< weight_tag >     weight    ;
typedef flags_diff< decoration_tag > decoration;

} // namespace detail

using detail::foreground;
using detail::background;
using detail::colors    ;
using detail::weight    ;
using detail::decoration;

static detail::flags default_flags;

} // namespace tos
} // namespace zi

#endif
