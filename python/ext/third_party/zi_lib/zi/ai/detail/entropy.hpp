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

#ifndef ZI_AI_DETAIL_ENTROPY_HPP
#define ZI_AI_DETAIL_ENTROPY_HPP 1

#include <zi/utility/assert.hpp>
#include <zi/math/constants.hpp>

#include <limits>
#include <cmath>

namespace zi {
namespace ai {
namespace detail {

inline double entropy( double probability )
{
    if (( probability     < std::numeric_limits< double >::epsilon() ) ||
        ( 1 - probability < std::numeric_limits< double >::epsilon() ))
    {
        return 0;
    }

    //static const double one_over_ln_2 = static_cast< double >( 1 ) / std::log( 2 );

    return ( -probability * std::log( probability )
             -( 1 - probability ) * std::log( 1 - probability ) ) *
        ( math::constants< double >::one_over_ln_two() );
}

inline double entropy( double instances_a, double instances_b )
{
    if ( instances_b == 0 || instances_a == 0 )
    {
        return 0;
    }
    return entropy( instances_a / ( instances_a + instances_b ) );
}

} // namespace detail
} // namespace ai
} // namespace zi



#endif
