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

#ifndef ZI_TIME_TIME_UNITS_HPP
#define ZI_TIME_TIME_UNITS_HPP 1

#include <zi/time/config.hpp>
#include <zi/bits/cstdint.hpp>

namespace zi {

namespace time_ {

template< int64_t Factor >
struct units_tpl
{
    static const int64_t factor = Factor;
};

} // namespace time_

typedef time_::units_tpl< 1LL >              in_nsecs;
typedef time_::units_tpl< 1LL >              in_nanoseconds;
typedef time_::units_tpl< 1000LL >           in_usecs;
typedef time_::units_tpl< 1000LL >           in_microseconds;
typedef time_::units_tpl< 1000000LL >        in_msecs;
typedef time_::units_tpl< 1000000LL >        in_milliseconds;
typedef time_::units_tpl< 1000000000LL >     in_secs;
typedef time_::units_tpl< 1000000000LL >     in_seconds;
typedef time_::units_tpl< 60000000000LL >    in_mins;
typedef time_::units_tpl< 60000000000LL >    in_minutes;
typedef time_::units_tpl< 3600000000000LL >  in_hours;
typedef time_::units_tpl< 86400000000000LL > in_days;

} // namespace zi

#endif
