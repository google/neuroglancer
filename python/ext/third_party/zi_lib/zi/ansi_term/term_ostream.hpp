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

#ifndef ZI_ANSI_TERM_TERM_OSTREAM_HPP
#define ZI_ANSI_TERM_TERM_OSTREAM_HPP 1

#include <zi/config/config.hpp>
#include <zi/ansi_term/constants.hpp>
#include <zi/ansi_term/tags.hpp>
#include <zi/ansi_term/flags.hpp>

#include <zi/bits/cstdint.hpp>
#include <iostream>
#include <iomanip>
#include <queue>

namespace zi {
namespace tos {

namespace detail {
template <typename T> struct formatter;
}

class term_ostream {
private:
    std::ostream&             out_        ;
    detail::flags             flags_      ;
    std::queue<detail::flags> flags_stack_;

public:
    term_ostream(std::ostream &out = std::cout):
        out_(out), flags_(), flags_stack_() {}

    ~term_ostream()
    {
        flush();
    }

    void flush()
    {
        out_.flush();
    }

    void reset()
    {
        out_.flush();
        flags_ = detail::flags();
    }

    void move_to(int l)
    {
        out_ << "\033[" << l << 'G';
    }

    void move_forward(int l)
    {
        out_ << "\033[" << l << 'C';
    }

    inline void push_flags()
    {
        flags_stack_.push(flags_);
    }

    inline void pop_flags()
    {
        if (flags_stack_.size()) {
            flags_ = flags_stack_.front();
            flags_stack_.pop();
        }
    }

    inline term_ostream &operator<< (const detail::flush_tag &)
    {
        flush();
        return *this;
    }

    inline term_ostream &operator<< (const detail::reset_tag &)
    {
        reset();
        return *this;
    }

    inline term_ostream &operator<< (const detail::push_flags_tag &)
    {
        push_flags();
        return *this;
    }

    inline term_ostream &operator<< (const detail::pop_flags_tag &)
    {
        pop_flags();
        return *this;
    }

    inline term_ostream &operator<< (color_constants color)
    {
        flags_.set_color(color);
        return *this;
    }

    inline term_ostream &operator<< (bg_color_constants color)
    {
        flags_.set_bg_color(color);
        return *this;
    }

    inline term_ostream &operator<< (weight_constants weight)
    {
        flags_.set_weight(weight);
        return *this;
    }

    inline term_ostream &operator<< (decoration_constants decor)
    {
        flags_.set_decoration(decor);
        return *this;
    }

    inline term_ostream &operator<< (const detail::flags &f)
    {
        flags_ = f;
        return *this;
    }

    template <typename T>
    inline term_ostream &operator<< (const detail::flags_diff<T> &diff)
    {
        diff(flags_);
        return *this;
    }

    template <typename T>
    inline term_ostream &operator<< (const detail::formatter<T> &f)
    {
        f(*this);
        return *this;
    }

    template <typename T>
    inline term_ostream &operator<< (const T &t)
    {
        if (flags_.dirty()) {
            flags_.clear();
            out_ << flags_ << t << default_flags;
        } else {
            out_ << t;
        }
        return *this;
    }

    inline term_ostream &operator<< (const std::ios_base::fmtflags &t)
    {
        out_ << t;
        return *this;
    }

    template <typename T> friend struct detail::formatter;

};

namespace detail {

template <> struct formatter<move_to_tag>
{
    int left_;
    formatter(int left): left_(left) {}
    inline void operator() (term_ostream& t) const { t.move_to(left_); }
};

template <> struct formatter<move_forward_tag>
{
    int len_;
    formatter(int len): len_(len) {}
    inline void operator() (term_ostream& t) const { t.move_forward(len_); }
};

typedef detail::formatter<detail::move_to_tag>      move_to     ;
typedef detail::formatter<detail::move_forward_tag> move_forward;

} // namespace detail

using detail::move_to     ;
using detail::move_forward;

} // namespace tos

namespace {
zi::tos::term_ostream tout;
zi::tos::term_ostream terr(std::cerr);
}

} // namespace zi

#endif
