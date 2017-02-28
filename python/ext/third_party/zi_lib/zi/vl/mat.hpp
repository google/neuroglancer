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

#ifndef ZI_VL_MAT_HPP
#define ZI_VL_MAT_HPP 1

#include <zi/vl/vec.hpp>
#include <zi/vl/detail/promote.hpp>
#include <zi/vl/detail/mat_lookup_table.hpp>
#include <zi/utility/assert.hpp>
#include <zi/utility/static_assert.hpp>

#include <zi/bits/type_traits.hpp>

#include <cstddef>
#include <stdexcept>
#include <limits>
#include <cmath>

#include <iostream>

namespace zi {
namespace vl {

namespace detail {

struct  eye_init_tag   { explicit eye_init_tag()   {} };
struct  trans_init_tag { explicit trans_init_tag() {} };
struct  minor_init_tag { explicit minor_init_tag() {} };

} // namespace detail

template< class T, std::size_t N >
class mat
{
private:
    ZI_STATIC_ASSERT( N > 0 ,                zero_length_mat );
    ZI_STATIC_ASSERT( is_scalar< T >::value, non_scalar_mat  );

    static const detail::mat_lookup_table< N > index;

public:
    static const std::size_t num_elements = N*N;

protected:
    T d[ N*N ];

public:

    typedef T              value_type;
    typedef T*             iterator;
    typedef const T*       const_iterator;
    typedef T*             reverse_iterator;
    typedef const T*       reverse_const_iterator;
    typedef T&             reference;
    typedef const T&       const_reference;
    typedef std::size_t    size_type;
    typedef std::ptrdiff_t difference_type;

    typedef mat< T, N > type;

    //
    // Constructors
    // ---------------------------------------------------------------------
    //

    explicit mat( const T& rcp = T() )
    {
        std::fill_n( begin(), size(), rcp );
    }

    explicit mat( const T& v, const detail::eye_init_tag& )
    {
        std::fill_n( begin(), size(), 0 );
        for ( size_type i = 0; i < num_elements; i += N + 1 )
        {
            d[ i ] = v;
        }
    }

    explicit mat( const vec< T, N >& diag,
                  const detail::eye_init_tag& )
    {
        std::fill_n( begin(), size(), 0 );
        for ( size_type p = 0, s = 0; s < N; ++s, p += N + 1 )
        {
            d[ p ] = diag.at( s );
        }
    }

    explicit mat( const T& p00, const T& p01,
                  const T& p10, const T& p11 )
    {
        ZI_ASSERT( N == 2 && "ctor_only_avaible_mat_of_size_2" );
        d[ 0 ] = p00; d[ 1 ] = p01;
        d[ 2 ] = p10; d[ 3 ] = p11;
    }

    explicit mat( const T& p00, const T& p01, const T& p02,
                  const T& p10, const T& p11, const T& p12,
                  const T& p20, const T& p21, const T& p22 )
    {
        ZI_ASSERT( N == 3 && "ctor_only_avaible_mat_of_size_3" );
        d[ 0 ] = p00; d[ 1 ] = p01; d[ 2 ] = p02;
        d[ 3 ] = p10; d[ 4 ] = p11; d[ 5 ] = p12;
        d[ 6 ] = p20; d[ 7 ] = p21; d[ 8 ] = p22;
    }

    explicit mat( const T& p00, const T& p01, const T& p02, const T& p03,
                  const T& p10, const T& p11, const T& p12, const T& p13,
                  const T& p20, const T& p21, const T& p22, const T& p23,
                  const T& p30, const T& p31, const T& p32, const T& p33 )
    {
        ZI_ASSERT( N == 4 && "ctor_only_avaible_mat_of_size_4" );
        d[ 0 ] = p00; d[ 1 ] = p01; d[ 2 ] = p02; d[ 3 ] = p03;
        d[ 4 ] = p10; d[ 5 ] = p11; d[ 6 ] = p12; d[ 7 ] = p13;
        d[ 8 ] = p20; d[ 9 ] = p21; d[ 10] = p22; d[ 11] = p23;
        d[ 12] = p30; d[ 13] = p31; d[ 14] = p32; d[ 15] = p33;
    }

    template< class X >
    explicit mat( const mat< X, N >& rcp )
    {
        for ( size_type i = 0; i < size(); ++i )
        {
            d[ i ] = static_cast< T >( rcp.elem( i ) );
        }
    }

    explicit mat( const mat< T, N >& rcp, const detail::trans_init_tag& )
    {
        for ( size_type i = 0; i < N; ++i )
        {
            for ( size_type j = 0; j < N; ++j )
            {
                at( i, j ) = rcp.at( j, i );
            }
        }
    }

    explicit mat( const mat< T, N+1 >& rcp,
                  size_type r, size_type c,
                  const detail::minor_init_tag& )
    {
        for ( size_type sr = 0, dr = 0; dr < N; ++sr, ++dr )
        {
            if ( dr == r )
            {
                ++sr;
            }

            for ( std::size_t sc = 0, dc = 0; dc < N; ++sc, ++dc )
            {
                if ( dc == c )
                {
                    ++sc;
                }
                at( dr, dc ) = rcp.at( sr, sc );
            }
        }
    }



    //
    // Accessors
    // ---------------------------------------------------------------------
    //

public:

#define ZI_VL_INDEX_ACCESSOR_BODY( idx1, idx2 )                         \
    ZI_ASSERT( ( idx1 < N ) && ( idx2 < N ) && "out of range" );        \
        return d[ index( idx1, idx2 ) ]


#define ZI_VL_INDEX_ACCESSOR_MEMBER( accessor )                 \
    reference accessor( size_type i, size_type j )              \
    {                                                           \
        ZI_VL_INDEX_ACCESSOR_BODY( i, j );                      \
    }                                                           \
    const_reference accessor( size_type i, size_type j ) const  \
    {                                                           \
        ZI_VL_INDEX_ACCESSOR_BODY( i, j );                      \
    }

    ZI_VL_INDEX_ACCESSOR_MEMBER( operator() )
    ZI_VL_INDEX_ACCESSOR_MEMBER( at )

#undef ZI_VL_INDEX_ACCESSOR_MEMBER
#undef ZI_VL_INDEX_ACCESSOR_BODY

    reference elem( size_type i )
    {
        ZI_ASSERT( i < num_elements && "out of range" );
        return d[ i ];
    }

    const_reference elem( size_type i ) const
    {
        ZI_ASSERT( i < num_elements && "out of range" );
        return d[ i ];
    }

    const T* data() const
    {
        return d;
    }

    T* data()
    {
        return d;
    }

    const T* c_array() const
    {
        return d;
    }

    T* c_array()
    {
        return d;
    }

    template< std::size_t I, std::size_t J >
    reference get()
    {
        ZI_STATIC_ASSERT( ( I < N ) && ( J < N ), get_out_of_range );
        return d[ index( I, J ) ];
    }

    template< std::size_t I, std::size_t J >
    const_reference get() const
    {
        ZI_STATIC_ASSERT( ( I < N ) && ( J < N ), get_out_of_range );
        return d[ index( I, J ) ];
    }

    //
    // Iterators
    // ---------------------------------------------------------------------
    //

    iterator begin()
    {
        return d;
    }

    const_iterator begin() const
    {
        return d;
    }

    iterator end()
    {
        return d + num_elements;
    }

    const_iterator end() const
    {
        return d + num_elements;
    }

    reverse_iterator rbegin()
    {
        return d + num_elements - 1;
    }

    reverse_const_iterator rbegin() const
    {
        return d + num_elements - 1;
    }

    reverse_iterator rend()
    {
        return d - 1;
    }

    reverse_const_iterator rend() const
    {
        return d - 1;
    }

    reference front()
    {
        return d[ 0 ];
    }

    const_reference front() const
    {
        return d[ 0 ];
    }

    reference back()
    {
        return d[ num_elements - 1 ];
    }

    const_reference back() const
    {
        return d[ num_elements - 1 ];
    }


    //
    // Min Max Elements
    // ---------------------------------------------------------------------
    //

    const T& min() const
    {
        return *::std::min_element( begin(), end() );
    }

    size_type min_index() const
    {
        return ::std::min_element( begin(), end() ) - begin();
    }


    const T& max() const
    {
        return *::std::max_element( begin(), end() );
    }

    size_type max_index() const
    {
        return ::std::max_element( begin(), end() ) - begin();
    }


    T absmax() const
    {
        T m = -this->min();
        return ::std::max( this->max(), m );
    }

    size_type absmax_index() const
    {
        size_type mini = this->min_index();
        size_type maxi = this->max_index();
        return ( -d[ mini ] > d[ maxi ] ) ? mini : maxi;
    }

    //
    // Assignments
    // ---------------------------------------------------------------------
    //

    template< class O >
    mat< T, N >& operator=( const mat< O, N >& rhs )
        {
            for ( size_type i = 0; i < num_elements; ++i )
            {
                d[ i ] = rhs.elem( i );
            }
            return *this;
        }

    mat< T, N >& operator=( const mat< T, N >& rhs )
    {
        for ( size_type i = 0; i < num_elements; ++i )
        {
            d[ i ] = rhs.elem( i );
        }
        return *this;
    }

    mat< T, N >& operator=( const T& rhs )
    {
        std::fill_n( begin(), num_elements, rhs );
        return *this;
    }

    void fill( const T& val )
    {
        std::fill_n( begin(), num_elements, val );
    }

    void assign( const T& val )
    {
        std::fill_n( begin(), num_elements, val );
    }


    //
    // Compound Assignment Operators
    // ---------------------------------------------------------------------
    //

#define ZI_VL_COMPOUND_OPERATOR_SCALAR( op )                        \
                                                                    \
    mat< T, N >& operator op ( const T& rhs )                       \
    {                                                               \
        for ( size_type i = 0; i < num_elements; ++i )              \
        {                                                           \
            d[ i ] op rhs;                                          \
        }                                                           \
        return *this;                                               \
    }

#define ZI_VL_COMPOUND_OPERATOR_TYPE( op )                          \
                                                                    \
    template< class X >                                             \
    mat< T, N >& operator op ( const mat< X, N >& rhs )             \
    {                                                               \
        for ( size_type i = 0; i < num_elements; ++i )              \
        {                                                           \
            d[ i ] op rhs.elem( i );                                \
        }                                                           \
        return *this;                                               \
    }                                                               \
                                                                    \
    mat< T, N >& operator op ( const mat< T, N >& rhs )             \
    {                                                               \
        for ( size_type i = 0; i < num_elements; ++i )              \
        {                                                           \
            d[ i ] op rhs.elem( i );                                \
        }                                                           \
        return *this;                                               \
    }

    ZI_VL_COMPOUND_OPERATOR_SCALAR( += )
    ZI_VL_COMPOUND_OPERATOR_SCALAR( -= )
    ZI_VL_COMPOUND_OPERATOR_SCALAR( *= )
    ZI_VL_COMPOUND_OPERATOR_SCALAR( /= )

    ZI_VL_COMPOUND_OPERATOR_TYPE( += )
    ZI_VL_COMPOUND_OPERATOR_TYPE( -= )

#undef ZI_VL_COMPOUND_OPERATOR_SCALAR
#undef ZI_VL_COMPOUND_OPERATOR_TYPE

    mat< T, N >& operator*=( const mat< T, N >& rhs )
    {
        *this = ( *this * rhs );
        return *this;
    }

    template< class X >
    mat< T, N >& operator/=( const mat< X, N >& rhs )
    {
        *this = ( *this * inv( rhs ) );
        return *this;
    }

    mat< T, N >& operator/=( const mat< T, N >& rhs )
    {
        *this = ( *this * inv( rhs ) );
        return *this;
    }

    // todo: rest

    //
    // Rest of the members
    // ---------------------------------------------------------------------
    //

public:

    static size_type size()
    {
        return num_elements;
    }

    void swap( mat< T, N >& rhs )
    {
        for ( size_type i = 0; i < N; ++i )
        {
            ::std::swap( d[ i ], rhs.d[ i ] );
        }
    }

    static void rangecheck( size_type i )
    {
        if ( i >= size() )
        {
            throw std::out_of_range( "mat<>: index out of range" );
        }
    }

    static const mat< T, N > one ;
    static const mat< T, N > zero;
    static const mat< T, N > eye ;
    static const mat< T, N > identity ;

    vec< T, N >
    diagonal() const
    {
        vec< T, N > res;
        for ( size_type i = 0, j = 0; i < num_elements; i += N + 1, ++j )
        {
            res.at( j ) = d[ i ];
        }
        return res;
    }

    vec< T, N >
    get_major_diagonal() const
    {
        return diagonal();
    }

    vec< T, N >
    get_semimajor_diagonal() const
    {
        vec< T, N > res;
        for ( size_type i = N-1, j = 0; i < num_elements; i += N - 1, ++j )
        {
            res.at( j ) = d[ i ];
        }
        return res;
    }
/*
#ifndef ZI_OS_MACOS
    template< class O >
    bool equals( const mat< O, N >& rhs,
                 typename detail::promote< T, O >::type epsilon =
                 std::numeric_limits< typename detail::promote< T, O >::type >::epsilon() ) const
    {
        typedef typename detail::promote< T, O >::type promoted_type;

        for ( std::size_t i = 0; i < num_elements; ++i )
        {
            if ( std::fabs( static_cast< promoted_type >( rhs.elem( i ) ) -
                            static_cast< promoted_type >( d[ i ] ) ) <= epsilon )
            {
                return false;
            }
        }
        return true;
    }
#endif
*/
    bool equals( const mat< T, N >& rhs,
                 T epsilon =
                 std::numeric_limits< T >::epsilon() ) const
    {
        for ( std::size_t i = 0; i < num_elements; ++i )
        {
            if ( std::fabs( static_cast< T >( rhs.elem( i ) ) - d[ i ] ) <= epsilon )
            {
                return false;
            }
        }
        return true;
    }


    template< std::size_t R >
    vec< T, N > get_row() const
    {
        ZI_STATIC_ASSERT( R < N , row_out_of_range );
        vec< T, N > res;

        for ( size_type di = 0, si = R*N; di < N; ++di, ++si )
        {
            res.at( di ) = d[ si ];
        }
        return res;
    }

    template< std::size_t C >
    vec< T, N > get_column() const
    {
        ZI_STATIC_ASSERT( C < N , column_out_of_range );
        vec< T, N > res;

        for ( size_type di = 0, si = C; di < N; ++di, si += N )
        {
            res.at( di ) = d[ si ];
        }
        return res;
    }


    vec< T, N > get_row( size_type r ) const
    {
        rangecheck( r );
        vec< T, N > res;

        for ( size_type di = 0, si = r*N; di < N; ++di, ++si )
        {
            res.at( di ) = d[ si ];
        }
        return res;
    }

    vec< T, N > get_column( size_type c ) const
    {
        rangecheck( c );
        vec< T, N > res;

        for ( size_type di = 0, si = c; di < N; ++di, si += N )
        {
            res.at( di ) = d[ si ];
        }
        return res;
    }

    template< std::size_t R >
    void set_row( const vec< T, N >& r )
    {
        ZI_STATIC_ASSERT( R < N , row_out_of_range );
        for ( size_type di = 0, si = R*N; di < N; ++di, ++si )
        {
            d[ si ] = r.at( di );
        }
    }

    template< std::size_t C >
    void set_column( const vec< T, N >& c )
    {
        ZI_STATIC_ASSERT( C < N , column_out_of_range );
        for ( size_type di = 0, si = C; di < N; ++di, si += N )
        {
            d[ si ] = c.at( di );
        }
    }

    template< bool B >
    void set_row( size_type idx, const vec< T, N >& r )
    {
        rangecheck( r );
        for ( size_type di = 0, si = idx*N; di < N; ++di, ++si )
        {
            d[ si ] = r.at( di );
        }
    }

    template< bool B >
    void set_column( size_type idx, const vec< T, N >& c )
    {
        rangecheck( idx );
        for ( size_type di = 0, si = idx; di < N; ++di, si += N )
        {
            d[ si ] = c.at( di );
        }
    }

    void swap_columns( size_type src_col,
                       size_type target_col,
                       size_type first_row = 0,
                       size_type last_row = N-1 )
    {
        ZI_ASSERT( ( src_col < N ) && ( target_col < N ) && "out of range" );
        ZI_ASSERT( ( first_row < N ) && ( last_row < N ) && "out of range" );

        if ( src_col == target_col )
        {
            return;
        }

        for ( size_type i = first_row; i <= last_row; ++i )
        {
            std::swap( d[ index( i, src_col ) ], d[ index( i, target_col ) ] );
        }
    }

    void swap_rows( size_type src_row,
                    size_type target_row,
                    size_type first_col = 0,
                    size_type last_col = N-1 )
    {
        ZI_ASSERT( ( src_row < N ) && ( target_row < N ) && "out of range" );
        ZI_ASSERT( ( first_col < N ) && ( last_col < N ) && "out of range" );

        if ( src_row == target_row )
        {
            return;
        }

        for ( size_type i = first_col; i <= last_col; ++i )
        {
            std::swap( d[ index( src_row, i ) ], d[ index( target_row, i ) ] );
        }

    }

};

template< class T, std::size_t N >
const detail::mat_lookup_table< N > mat< T, N >::index;

template< class T, std::size_t N >
const mat< T, N > mat< T, N >::one( 1 );

template< class T, std::size_t N >
const mat< T, N > mat< T, N >::zero( 0 );

template< class T, std::size_t N >
const mat< T, N > mat< T, N >::eye( 1, detail::eye_init_tag() );

template< class T, std::size_t N >
const mat< T, N > mat< T, N >::identity( 1, detail::eye_init_tag() );

//
// Comparison
// ---------------------------------------------------------------------
//

template< class T, class O, std::size_t N >
inline bool operator==( const mat< T, N >& lhs,
                        const mat< O, N >& rhs )
{
    return std::equal( lhs.begin(), lhs.end(), rhs.begin() );
}

template< class T, std::size_t N >
inline bool operator==( const mat< T, N >& lhs,
                        const mat< T, N >& rhs )
{
    return std::equal( lhs.begin(), lhs.end(), rhs.begin() );
}

template< class T, class O, std::size_t N >
inline bool operator!=( const mat< T, N >& lhs,
                        const mat< O, N >& rhs )
{
    return !( lhs == rhs );
}

template< class T, std::size_t N >
inline bool operator!=( const mat< T, N >& lhs,
                        const mat< T, N >& rhs )
{
    return !( lhs == rhs );
}

template< class T, class O, std::size_t N >
inline bool operator<( const mat< T, N >& lhs,
                       const mat< O, N >& rhs )
{
    return std::lexicographical_compare( lhs.begin(), lhs.end(),
                                         rhs.begin(), rhs.end() );
}

template< class T, std::size_t N >
inline bool operator<( const mat< T, N >& lhs,
                       const mat< T, N >& rhs )
{
    return std::lexicographical_compare( lhs.begin(), lhs.end(),
                                         rhs.begin(), rhs.end() );
}

template< class T, class O, std::size_t N >
inline bool operator>( const mat< T, N >& lhs,
                       const mat< O, N >& rhs )
{
    return ( rhs < lhs );
}

template< class T, std::size_t N >
inline bool operator>( const mat< T, N >& lhs,
                       const mat< T, N >& rhs )
{
    return ( rhs < lhs );
}

template< class T, class O, std::size_t N >
inline bool operator<=( const mat< T, N >& lhs,
                        const mat< O, N >& rhs )
{
    return !( rhs < lhs );
}

template< class T, std::size_t N >
inline bool operator<=( const mat< T, N >& lhs,
                        const mat< T, N >& rhs )
{
    return !( rhs < lhs );
}

template< class T, class O, std::size_t N >
inline bool operator>=( const mat< T, N >& lhs,
                        const mat< O, N >& rhs )
{
    return !( lhs < rhs );
}

template< class T, std::size_t N >
inline bool operator>=( const mat< T, N >& lhs,
                        const mat< T, N >& rhs )
{
    return !( lhs < rhs );
}

//
// Basic arithmetic
// ---------------------------------------------------------------------
//

#define ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE( op )          \
                                                                \
    template< class T, std::size_t N >                          \
    inline                                                      \
    typename mat< T, N >::type                                  \
    operator op( const T& lhs, const mat< T, N >& rhs )         \
    {                                                           \
        typename mat< T, N >::type res( lhs );                  \
        res op##= rhs;                                          \
        return res;                                             \
    }                                                           \
                                                                \
    template< class T, class O, std::size_t N >                 \
    inline                                                      \
    typename detail::enable_if                                  \
    < is_scalar< T >,                                           \
      mat< typename detail::promote< O, T >::type, N > >::type  \
    operator op( const T& lhs, const mat< O, N >& rhs )         \
    {                                                           \
        mat< typename detail::promote< O, T >::type, N >        \
            res( lhs );                                         \
        res op##= rhs;                                          \
        return res;                                             \
    }

#define ZI_VL_INLINE_BINARY_OPERATOR_VEC_TYPE( op )                     \
                                                                        \
    template< class T, class O, std::size_t N >                         \
    inline                                                              \
    vec< typename detail::promote< T, O >::type, N >                    \
    operator op( const vec< T, N >& lhs, const mat< O, N >& rhs )       \
    {                                                                   \
        typedef typename detail::promote< T, O >::type PT;              \
        vec< PT, N > res;                                               \
                                                                        \
        for( std::size_t r = 0; r < N; ++r )                            \
        {                                                               \
            res.at( r ) = static_cast< T >( 0 );                        \
            for( std::size_t c = 0; c < N; ++c )                        \
            {                                                           \
                res.at( r ) += static_cast< PT >( lhs.at( c ) ) *       \
                    rhs.at( r, c );                                     \
            }                                                           \
        }                                                               \
                                                                        \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T, std::size_t N >                                  \
    inline                                                              \
    vec< T, N >                                                         \
    operator op( const vec< T, N >& lhs, const mat< T, N >& rhs )       \
    {                                                                   \
        vec< T, N > res;                                                \
                                                                        \
        for( std::size_t r = 0; r < N; ++r )                            \
        {                                                               \
            res.at( r ) = static_cast< T >( 0 );                        \
            for( std::size_t c = 0; c < N; ++c )                        \
            {                                                           \
                res.at( r ) += lhs.at( c ) * rhs.at( r, c );            \
            }                                                           \
        }                                                               \
                                                                        \
        return res;                                                     \
    }

#define ZI_VL_INLINE_BINARY_OPERATOR_TYPE_VEC( op )                     \
                                                                        \
    template< class T, class O, std::size_t N >                         \
    inline                                                              \
    vec< typename detail::promote< T, O >::type, N >                    \
    operator op( const mat< T, N >& lhs, const vec< O, N >& rhs )       \
    {                                                                   \
        typedef typename detail::promote< T, O >::type PT;              \
        vec< PT, N > res;                                               \
                                                                        \
        for( std::size_t r = 0; r < N; ++r )                            \
        {                                                               \
            res.at( r ) = static_cast< T >( 0 );                        \
            for( std::size_t c = 0; c < N; ++c )                        \
            {                                                           \
                res.at( r ) += static_cast< PT >( rhs.at( c ) ) *       \
                    lhs.at( r, c );                                     \
            }                                                           \
        }                                                               \
                                                                        \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T, std::size_t N >                                  \
    inline                                                              \
    vec< T, N >                                                         \
    operator op( const mat< T, N >& lhs, const vec< T, N >& rhs )       \
    {                                                                   \
        vec< T, N > res;                                                \
                                                                        \
        for( std::size_t r = 0; r < N; ++r )                            \
        {                                                               \
            res.at( r ) = static_cast< T >( 0 );                        \
            for( std::size_t c = 0; c < N; ++c )                        \
            {                                                           \
                res.at( r ) += rhs.at( c ) * lhs.at( r, c );            \
            }                                                           \
        }                                                               \
                                                                        \
        return res;                                                     \
    }




#define ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( op )                  \
                                                                        \
    template< class O, class T, std::size_t N >                         \
    inline                                                              \
    typename detail::enable_if                                          \
    < is_scalar< O >,                                                   \
      mat< typename detail::promote< O, T >::type, N > >::type          \
    operator op( const mat< T, N >& lhs, const O& rhs )                 \
    {                                                                   \
        mat< typename detail::promote< O, T >::type, N > res( lhs );    \
        res op##= rhs;                                                  \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T, std::size_t N >                                  \
    inline                                                              \
    mat< T, N >                                                         \
    operator op( const mat< T, N >& lhs, const T& rhs )                 \
    {                                                                   \
        mat< T, N > res( lhs );                                         \
        res op##= rhs;                                                  \
        return res;                                                     \
    }

#define ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE( op )                    \
    template< class T, class O, std::size_t N >                         \
    inline                                                              \
    mat< typename detail::promote< O, T >::type, N >                    \
    operator op( const mat< T, N >& lhs, const mat< O, N >& rhs )       \
    {                                                                   \
        mat< typename detail::promote< O, T >::type, N > res( lhs );    \
        res op##= rhs;                                                  \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T, std::size_t N >                                  \
    inline                                                              \
    typename mat< T, N >::type                                          \
    operator op( const mat< T, N >& lhs, const mat< T, N >& rhs )       \
    {                                                                   \
        mat< T, N > res( lhs );                                         \
        res op##= rhs;                                                  \
        return res;                                                     \
    }


#define ZI_VL_INLINE_BINARY_OPERATOR( op )               \
    ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( op )       \
    ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE( op )       \
    ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE( op )

ZI_VL_INLINE_BINARY_OPERATOR( + )
ZI_VL_INLINE_BINARY_OPERATOR( - )

ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE( * )
ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( * )
ZI_VL_INLINE_BINARY_OPERATOR_VEC_TYPE( * )
ZI_VL_INLINE_BINARY_OPERATOR_TYPE_VEC( * )

ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( / )

#undef ZI_VL_INLINE_BINARY_OPERATOR
#undef ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE
#undef ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE
#undef ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR
#undef ZI_VL_INLINE_BINARY_OPERATOR_TYPE_VEC
#undef ZI_VL_INLINE_BINARY_OPERATOR_VEC_TYPE


template< class T, class O, std::size_t N >
inline
mat< typename detail::promote< T, O >::type, N >
operator*( const mat< T, N >& lhs, const mat< O, N >& rhs )
{
    typedef typename detail::promote< T, O >::type promoted_type;
    mat< promoted_type, N > res( 0 );

    for ( std::size_t r = 0, i = 0; r < N; ++r )
    {
        for ( std::size_t c = 0; c < N; ++c, ++i )
        {
            for ( std::size_t j = 0; j < N; ++j )
            {
                res.elem( i ) +=
                    static_cast< promoted_type >( lhs.at( r, j ) ) * rhs.at( j, c );
            }
        }
    }

    return res;
}

template< class T, std::size_t N >
inline mat< T, N >
operator*( const mat< T, N >& lhs, const mat< T, N >& rhs )
{
    mat< T, N > res( 0 );

    for ( std::size_t r = 0, i = 0; r < N; ++r )
    {
        for ( std::size_t c = 0; c < N; ++c, ++i )
        {
            for ( std::size_t j = 0; j < N; ++j )
            {
                res.elem( i ) += lhs.at( r, j ) * rhs.at( j, c );
            }
        }
    }

    return res;
}


template< class T >
inline mat< T, 1 >
operator*( const mat< T, 1 >& lhs, const mat< T, 1 >& rhs )
{
    return mat< T, 1 >( lhs.elem( 0 ) * rhs.elem( 0 ) );
}

template< class T, class O, std::size_t N >
inline vec< T, N >&
operator*=( vec< T, N >& v, const mat< O, N >& m )
{
    v = v*m;
    return v;
}

template< class T, std::size_t N >
inline vec< T, N >&
operator*=( vec< T, N >& v, const mat< T, N >& m )
{
    v = v*m;
    return v;
}

template< class T, std::size_t N >
inline
mat< T, N > operator+( const mat< T, N >& rhs )
{
    return rhs;
}

template< class T, std::size_t N >
inline
mat< T, N > operator-( const mat< T, N >& rhs )
{
    mat< T, N > res( rhs );
    for ( std::size_t i = 0; i < N*N; ++i )
    {
        res[ i ] = -rhs.elem( i );
    }
    return res;
}

template< class T, std::size_t N, class CharT, class Traits >
typename detail::enable_if_c< ( N > 2 ), ::std::basic_ostream< CharT, Traits >& >::type
operator<<( ::std::basic_ostream< CharT, Traits >& os,
            const mat< T, N >& m )
{
    std::size_t i;
    os << '/';
    for ( i = 0; i < N; ++i )
    {
        os << ' ' << m.elem( i );
    }
    os << " \\\n";

    for ( std::size_t r = 1; r < N - 1; ++r )
    {
        os << '|';
        for ( std::size_t j = 0; j < N; ++i, ++j )
        {
            os << ' ' << m.elem( i );
        }
        os << " |\n";
    }

    os << '\\';
    for ( ; i < N*N; ++i )
    {
        os << ' ' << m.elem( i );
    }

    return os << " /";

}

template< class T, class CharT, class Traits >
::std::basic_ostream< CharT, Traits >&
operator<<( ::std::basic_ostream< CharT, Traits >& os,
            const mat< T, 1 >& m )
{
    return os << "< " << m.elem( 0 ) << " >";
}

template< class T, class CharT, class Traits >
::std::basic_ostream< CharT, Traits >&
operator<<( ::std::basic_ostream< CharT, Traits >& os,
            const mat< T, 2 >& m )
{
    os << "/ " << m.elem( 0 ) << ' ' << m.elem( 1 ) << " \\\n";
    return os << "\\ " << m.elem( 2 ) << ' ' << m.elem( 3 ) << " /";
}

template< class T, class O, std::size_t N >
bool equals( const mat< T, N >& lhs, const mat< O, N >& rhs )
{
    return lhs.equals( rhs );
}

template< class T, std::size_t N >
bool equals( const mat< T, N >& lhs, const mat< T, N >& rhs )
{
    return lhs.equals( rhs );
}

template< class T, std::size_t N >
vec< T, N > get_diagonal( const mat< T, N >& rhs )
{
    return rhs.diagonal();
}

template< class T, std::size_t N >
vec< T, N > get_major_diagonal( const mat< T, N >& rhs )
{
    return rhs.get_major_diagonal();
}

template< class T, std::size_t N >
vec< T, N > get_semimajor_diagonal( const mat< T, N >& rhs )
{
    return rhs.get_semimajor_diagonal();
}

#define ZI_VL_TYPEDEF_MAT_TYPE( len )                   \
    typedef mat< int, len > mat##len##i;                \
    typedef mat< long, len > mat##len##l;               \
    typedef mat< long long, len > mat##len##ll;         \
    typedef mat< float, len > mat##len##f;              \
    typedef mat< double, len > mat##len##d;             \
    typedef mat< long double, len > mat##len##ld


ZI_VL_TYPEDEF_MAT_TYPE( 1 );
ZI_VL_TYPEDEF_MAT_TYPE( 2 );
ZI_VL_TYPEDEF_MAT_TYPE( 3 );
ZI_VL_TYPEDEF_MAT_TYPE( 4 );
ZI_VL_TYPEDEF_MAT_TYPE( 5 );
ZI_VL_TYPEDEF_MAT_TYPE( 6 );
ZI_VL_TYPEDEF_MAT_TYPE( 7 );
ZI_VL_TYPEDEF_MAT_TYPE( 8 );
ZI_VL_TYPEDEF_MAT_TYPE( 9 );
ZI_VL_TYPEDEF_MAT_TYPE( 10 );
ZI_VL_TYPEDEF_MAT_TYPE( 11 );
ZI_VL_TYPEDEF_MAT_TYPE( 12 );
ZI_VL_TYPEDEF_MAT_TYPE( 13 );
ZI_VL_TYPEDEF_MAT_TYPE( 14 );
ZI_VL_TYPEDEF_MAT_TYPE( 15 );
ZI_VL_TYPEDEF_MAT_TYPE( 16 );
ZI_VL_TYPEDEF_MAT_TYPE( 17 );
ZI_VL_TYPEDEF_MAT_TYPE( 18 );
ZI_VL_TYPEDEF_MAT_TYPE( 19 );
ZI_VL_TYPEDEF_MAT_TYPE( 20 );

#undef ZI_VL_TYPEDEF_MAT_TYPE

} // namespace vl
} // namespace zi

// provide functionality

#include <zi/vl/mat_functions.hpp>

#endif
