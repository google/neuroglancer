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

#ifndef ZI_VL_DETAIL_MAT_LOOKUP_TABLE_HPP
#define ZI_VL_DETAIL_MAT_LOOKUP_TABLE_HPP 1

#include <zi/utility/assert.hpp>
#include <zi/utility/non_copyable.hpp>

#include <cstddef>

namespace zi {
namespace vl {
namespace detail {

template< std::size_t N >
class mat_lookup_table: non_copyable
{
private:
    std::size_t table_[ N ][ N ];
    std::size_t rows_[ N ];

public:
    mat_lookup_table()
    {
        for ( std::size_t idx = 0, r = 0; r < N; ++r )
        {
            rows_[ r ] = idx;
            for ( std::size_t c = 0; c < N; ++c, ++idx )
            {
                table_[ r ][ c ] = idx;
            }
        }
    }

    inline std::size_t operator()( const std::size_t r, const std::size_t c ) const
    {
        return table_[ r ][ c ];
    }

    inline std::size_t operator()( const std::size_t r ) const
    {
        return rows_[ r ];
    }

};

} // namespace detail
} // namespace vl
} // namespace zi



#endif
