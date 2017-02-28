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

#ifndef ZI_TIME_TIMER_HPP
#define ZI_TIME_TIMER_HPP 1

#include <zi/time/config.hpp>
#include <zi/time/wall_timer.hpp>
#include <zi/time/process_timer.hpp>
#include <zi/bits/cstdint.hpp>

#include <ctime>

namespace zi {

class timer
{
public:
    typedef wall_timer    wall   ;
    typedef process_timer process;


private:
    wall_timer    wall_   ;
    process_timer process_;

public:

    template< class T > struct tv
    {
        T wall, process;
    };

    timer(): wall_(), process_()
    {
        restart();
    }

    inline void restart()
    {
        wall_.restart();
        process_.restart();
    }

    inline void reset()
    {
        wall_.reset();
        process_.reset();
    }

    template< class T > inline void lap( ::zi::timer::tv< T > &v )
    {
        v.wall    = wall_.template lap< T >();
        v.process = process_.template lap< T >();
    }

    template< class T > inline void elapsed( ::zi::timer::tv< T > &v )
    {
        v.wall    = wall_.template elapsed< T >();
        v.process = process_.template elapsed< T >();
    }

    template< class T > inline void lap_elapsed( ::zi::timer::tv< T > &v )
    {
        v.wall    = wall_.template lap_elapsed< T >();
        v.process = process_.template lap_elapsed< T >();
    }

};

} // namespace zi

#endif
