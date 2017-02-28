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

#ifndef ZI_MESH_TRI_LIST_HPP
#define ZI_MESH_TRI_LIST_HPP 1

#include <zi/bits/cstdint.hpp>
#include <zi/bits/type_traits.hpp>
#include <zi/bits/unordered_set.hpp>

#include <zi/utility/for_each.hpp>
#include <zi/utility/static_assert.hpp>
#include <zi/utility/static_if.hpp>

#include <vector>
#include <cstddef>

namespace zi {
namespace mesh {

template< std::size_t S >
struct packed_tri_list
{
private:
    ZI_STATIC_ASSERT( S > 0  , zero_size_packed_tri_list );
    ZI_STATIC_ASSERT( S <= 21, oversized_packed_tri_list );

public:
    typedef typename if_< ( S > 10 ), uint64_t,
        typename if_< ( S > 5 ), uint32_t,
        typename if_< ( S > 3 ), uint16_t, uint8_t >::type
        >::type >::type packed_type;

    typedef typename if_< ( S > 16 ), uint32_t,
        typename if_< ( S > 8 ), uint16_t, uint8_t >::type
        >::type coordinate_type;

public:
    struct coordinate
    {
    private:
        packed_type packed_;

        static const std::size_t width        = S;
        static const std::size_t double_width = ( S << 1 );
        static const packed_type mask         = ( static_cast< packed_type >( 1 ) << S ) - 1;

    public:
        inline coordinate()
            : packed_( 0 )
        {
        }

        inline coordinate( const packed_type packed )
            : packed_( packed )
        {
        }

        inline coordinate( const coordinate_type x, const coordinate_type y, const coordinate_type z )
            : packed_( x )
        {
            packed_ <<= width;
            packed_ |= y;
            packed_ <<= width;
            packed_ |= z;
        }

        inline void set( const packed_type packed )
        {
            packed_ = packed;
        }

        inline void set( const coordinate_type x, const coordinate_type y, const coordinate_type z )
        {
            packed_ = x;
            packed_ <<= width;
            packed_ |= y;
            packed_ <<= width;
            packed_ |= z;
        }

        inline coordinate_type x() const
        {
            return static_cast< coordinate_type >( ( packed_ >> double_width ) & mask );
        }

        inline coordinate_type y() const
        {
            return static_cast< coordinate_type >( ( packed_ >> width ) & mask );
        }

        inline coordinate_type z() const
        {
            return static_cast< coordinate_type >( packed_ & mask );
        }

        inline operator packed_type() const
        {
            return packed_;
        }

    };


    struct triangle
    {
    private:
        coordinate c1_, c2_, c3_;

    public:
        inline triangle()
            : c1_(), c2_(), c3_()
        {
        }

        inline triangle( const coordinate& c1, const coordinate& c2, const coordinate& c3 )
            : c1_( c1 ), c2_( c2 ), c3_( c3 )
        {
        }

        inline triangle( const packed_type c1, const packed_type c2, const packed_type c3 )
            : c1_( c1 ), c2_( c2 ), c3_( c3 )
        {
        }

        inline triangle( const coordinate_type c11, const coordinate_type c12,
                         const coordinate_type c13, const coordinate_type c21,
                         const coordinate_type c22, const coordinate_type c23,
                         const coordinate_type c31, const coordinate_type c32,
                         const coordinate_type c33 )
            : c1_( c11, c12, c13 ), c2_( c21, c22, c23 ), c3_( c31, c32, c33 )
        {
        }

        inline coordinate& c1() { return c1_; }
        inline coordinate& c2() { return c2_; }
        inline coordinate& c3() { return c3_; }

        inline const coordinate& c1() const { return c1_; }
        inline const coordinate& c2() const { return c2_; }
        inline const coordinate& c3() const { return c3_; }

    };

private:
    std::vector< triangle > v_;

public:
    inline std::size_t size() const
    {
        return v_.size();
    }

    inline triangle& operator[]( std::size_t i )
    {
        return v_[ i ];
    }

    inline const triangle& operator[]( std::size_t i ) const
    {
        return v_[ i ];
    }

    inline void clear()
    {
        v_.clear();
    }

    inline void insert( const packed_type c1, const packed_type c2, const packed_type c3 )
    {
        v_.push_back( coordinate( c1, c2, c3 ) );
    }

    inline void insert( const coordinate_type c11, const coordinate_type c12,
                        const coordinate_type c13, const coordinate_type c21,
                        const coordinate_type c22, const coordinate_type c23,
                        const coordinate_type c31, const coordinate_type c32,
                        const coordinate_type c33 )
    {
        v_.push_back( coordinate( c11, c12, c13, c21, c22, c23, c31, c32, c33 ) );
    }

    inline std::size_t vertex_count() const
    {
        unordered_set< packed_type > s;
        FOR_EACH( it, v_ )
        {
            s.insert( it->c1() );
            s.insert( it->c2() );
            s.insert( it->c3() );
        }
        return s.size();
    }

};

} // namespace mesh
} // namespace zi

#endif
