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

#ifndef ZI_WATERSHED_QUICKIE_HPP
#define ZI_WATERSHED_QUICKIE_HPP 1

#include <zi/parallel/algorithm.hpp>
#include <zi/concurrency.hpp>
#include <zi/system.hpp>

#include <algorithm>
#include <utility>
#include <cstddef>
#include <iostream>

namespace zi {
namespace watershed {

template< class T, class R >
class quickie_impl
{
private:
    const T*          connections_                          ;
    const std::size_t x_dim_, y_dim_, z_dim_                ;
    const std::size_t size_thold_                           ;
    const T           low_thold_, hi_thold_, abs_low_thold_ ;
    R*                result_                               ;
    zi::mutex         mutex_                                ;


    void add_hi_threshold_edges_thread( std::size_t d, std::size_t z )
    {

        const std::size_t xy_dim      = x_dim_  * y_dim_;
        const std::size_t xyz_dim     = xy_dim  * z_dim_;
        const std::size_t xyz_dim2    = xy_dim  * z_dim_ * 2;
        const std::size_t nhood[6]    = { -1, -x_dim_, -xy_dim, 1, x_dim_, xy_dim };

        std::size_t j = z * xy_dim;
        std::size_t i = j + d * xyz_dim;
        for ( std::size_t y = 0; y < y_dim_; ++y )
        {
            for ( std::size_t x = 0; x < x_dim_; ++x, ++i, ++j )
            {
                if ((x == 0) && (d == 0)) continue;
                if ((y == 0) && (d == 1)) continue;
                if ((z == 0) && (d == 2)) continue;

                if ( connections_[ i ] >= hi_thold_ )
                {
                    result_[ j ]              |= (1 << d);
                    result_[ j + nhood[ d ] ] |= (8 << d);
                }

            }
        }
    }

public:
    quickie_impl( const T* conn,
                  const std::size_t x_dim,
                  const std::size_t y_dim,
                  const std::size_t z_dim,
                  const std::size_t size_thold,
                  const T low_thold,
                  const T hi_thold,
                  const T abs_low_thold,
                  R* result )
        : connections_( conn ),
          x_dim_( x_dim ),
          y_dim_( y_dim ),
          z_dim_( z_dim ),
          size_thold_( size_thold ),
          low_thold_( low_thold ),
          hi_thold_( hi_thold ),
          abs_low_thold_( abs_low_thold ),
          result_( result ),
          mutex_()
    {
        std::fill_n( result, x_dim * y_dim * z_dim, 0 );
    }

    void doit()
    {
        const std::size_t no_threads = zi::system::cpu_count * 2;
        zi::task_manager::simple tm( no_threads );
        tm.start();
        for ( std::size_t d = 0; d < 3; ++d )
        {
            for ( std::size_t z = 0; z < z_dim_; ++z )
            {
                tm.push_back( zi::run_fn
                              ( zi::bind
                                ( &quickie_impl::add_hi_threshold_edges_thread,
                                  this,
                                  d, z ) ));
            }
        }

        tm.join();
    }

};


} // namespace watershed
} // namespace zi

#endif

