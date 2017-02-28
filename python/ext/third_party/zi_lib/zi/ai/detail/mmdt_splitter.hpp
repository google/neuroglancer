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

#ifndef ZI_AI_DETAIL_MMDT_SPLITTER_HPP
#define ZI_AI_DETAIL_MMDT_SPLITTER_HPP 1

#include <zi/vl/vec.hpp>
#include <vector>
#include <cstddef>

namespace zi {
namespace ai {
namespace splitter {

template< class T, std::size_t N >
class mmdt
{
public:
    class split_fn
    {
    private:
        vl::vec< T, N > mu_;
        vl::vec< T, N > ni_;
        bool            all_same_;


    public:
        explicit split_fn( const vl::vec< T, N >& mu,
                           const vl::vec< T, N >& ni,
                           bool all_same )
            : mu_( mu ), ni_( ni ), all_same_( all_same )
        {
        }

        explicit split_fn( bool all_same )
            : mu_(), ni_(), all_same_( all_same )
        {
        }

        bool operator()( const vl::vec< T, N >& p ) const
        {
            if ( all_same_ )
            {
                return true;
            }
            double r = vl::dot( p - mu_, ni_ );
            return r > 0 ? true : ( r < 0 ? false : 1 );
        }
    };

    split_fn get_split_fn( const std::vector< vl::vec< T, N > >& patterns,
                           const std::vector< uint32_t >& positives,
                           const std::vector< uint32_t >& negatives,
                           double weight_positive = 1 ) const
    {
        if ( positives.size() == 0 || negatives.size() == 0 )
        {
            return split_fn( true );
        }

        vl::vec< T, N > mu_t( 0 );
        vl::vec< T, N > mu_f( 0 );

        FOR_EACH( it, positives )
        {
            uint32_t idx = ( *it );
            mu_t += patterns[ idx ];
        }

        FOR_EACH( it, negatives )
        {
            uint32_t idx = ( *it );
            mu_f += patterns[ idx ];
        }

        mu_t /= positives.size();
        mu_f /= negatives.size();

        return split_fn( ( mu_t + mu_f ) / 2, mu_t - mu_f, false );

    }

    mmdt< T, N > next() const
    {
        return *this;
    }

};


} // namespace splitter
} // namespace ai
} // namespace zi

#endif
