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

#ifndef ZI_VL_VEC_HPP
#define ZI_VL_VEC_HPP 1

#include <zi/vl/detail/promote.hpp>
#include <zi/vl/detail/enable_if.hpp>

#include <zi/utility/assert.hpp>
#include <zi/utility/non_copyable.hpp>
#include <zi/utility/static_assert.hpp>
#include <zi/utility/address_of.hpp>

#include <zi/bits/type_traits.hpp>

#include <limits>
#include <cstddef>
#include <stdexcept>
#include <algorithm>

namespace zi {
namespace vl {

template< class T, std::size_t N >
class vec;

template< class T, std::size_t N >
class vec
{
private:
    ZI_STATIC_ASSERT( N > 0 ,                non_positive_length_vec );
    ZI_STATIC_ASSERT( is_scalar< T >::value, not_scalar_type         );

protected:
    T d[ N ];

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

    typedef vec< T, N > type;

    //
    // Constructors
    // ---------------------------------------------------------------------
    //

    explicit vec( const T& rcp = T() )
    {
        std::fill_n( begin(), N, rcp );
    }

    explicit vec( const T& p0, const T& p1  )
    {
        ZI_ASSERT( N == 2 && "ctor_only_avaible_vec_of_size_2" );
        d[ 0 ] = p0;
        d[ 1 ] = p1;
    }

    explicit vec( const T& p0, const T& p1, const T& p2 )
    {
        ZI_ASSERT( N == 3 && "ctor_only_avaible_vec_of_size_3" );
        d[ 0 ] = p0;
        d[ 1 ] = p1;
        d[ 2 ] = p2;
    }

    explicit vec( const T& p0, const T& p1, const T& p2, const T& p3 )
    {
        ZI_ASSERT( N == 4 && "ctor_only_avaible_vec_of_size_4" );
        d[ 0 ] = p0;
        d[ 1 ] = p1;
        d[ 2 ] = p2;
        d[ 3 ] = p3;
    }

    template< class X >
    explicit vec( const vec< X, N >& rcp )
    {
        for ( size_type i = 0; i < N; ++i )
        {
            d[ i ] = static_cast< T >( rcp.at( i ) );
        }
    }

    template< class X, std::size_t M >
    explicit vec( const vec< X, M >& rcp, const T& append_value,
                  typename detail::enable_if_c< ( M == N-1 ), X >::type* = 0 )
    {
        for ( size_type i = 0; i < N - 1; ++i )
        {
            d[ i ] = static_cast< T >( rcp[ i ] );
        }
        d[ N-1 ] = append_value;
    }

    template< class X, std::size_t M >
    explicit vec( const T& prepend_value, const vec< X, M >& rcp,
                  typename detail::enable_if_c< ( M == N-1 ), X >::type* = 0 )
    {
        for ( size_type i = 0; i < N - 1; ++i )
        {
            d[ i + 1 ] = static_cast< T >( rcp[ i ] );
        }
        d[ 0 ] = prepend_value;
    }

    template< class X, std::size_t M, class Y, std::size_t Q >
    explicit vec( const vec< X, M >& rcpl, const vec< Y, Q >& rcpr,
                  typename detail::enable_if_c< ( M+Q == N ), X >::type* = 0 )
    {
        size_type i = 0;
        for ( size_type j = 0; j < M; ++i, ++j )
        {
            d[ i ] = static_cast< T >( rcpl[ i ] );
        }

        for ( size_type j = 0; j < Q; ++i, ++j )
        {
            d[ i ] = static_cast< T >( rcpr[ j ] );
        }

    }


    //
    // Accessors
    // ---------------------------------------------------------------------
    //

public:

#define ZI_VL_INDEX_ACCESSOR_BODY( idx )        \
    ZI_ASSERT( ( idx < N ) && "out of range" ); \
        return d[ idx ]


#define ZI_VL_INDEX_ACCESSOR_MEMBER( accessor )         \
    const_reference accessor( size_type i ) const       \
    {                                                   \
        ZI_VL_INDEX_ACCESSOR_BODY( i );                 \
    }                                                   \
        reference accessor( size_type i )               \
    {                                                   \
        ZI_VL_INDEX_ACCESSOR_BODY( i );                 \
    }

#define ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( name, idx )  \
    const_reference name() const                        \
    {                                                   \
        ZI_VL_INDEX_ACCESSOR_BODY( idx );               \
    }                                                   \
        reference name()                                \
    {                                                   \
        ZI_VL_INDEX_ACCESSOR_BODY( idx );               \
    }


    ZI_VL_INDEX_ACCESSOR_MEMBER( operator[] )
    ZI_VL_INDEX_ACCESSOR_MEMBER( operator() )
    ZI_VL_INDEX_ACCESSOR_MEMBER( at )
    ZI_VL_INDEX_ACCESSOR_MEMBER( elem )

    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( x, 0 );
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( y, 1 );
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( z, 2 );
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( w, 3 );
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( t, 3 );
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( r, 0 );
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( g, 1 );
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( b, 2 );
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( a, 3 );

#undef ZI_VL_INDEX_ACCESSOR_BODY
#undef ZI_VL_INDEX_ACCESSOR_MEMBER
#undef ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER

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


    template< std::size_t I >
    reference get()
    {
        ZI_STATIC_ASSERT( I < N, index_out_of_range );
        return d[ I ];
    }

    template< std::size_t I >
    const_reference get() const
    {
        ZI_STATIC_ASSERT( I < N, index_out_of_range );
        return d[ I ];
    }

    template< std::size_t I, std::size_t J >
    vec< T, I > subvector() const
    {
        ZI_STATIC_ASSERT( ( I + J <= N ), index_out_of_range );
        vec< T, I > res;
        for ( std::size_t di = 0, si = J; di < I; ++di, ++si )
        {
            res.at( di ) = d[ si ];
        }
        return res;
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
        return d + N;
    }

    const_iterator end() const
    {
        return d + N;
    }

    reverse_iterator rbegin()
    {
        return d + N - 1;
    }

    reverse_const_iterator rbegin() const
    {
        return d + N - 1;
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
        return d[ N - 1 ];
    }

    const_reference back() const
    {
        return d[ N - 1 ];
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
    vec< T, N >& operator=( const vec< O, N >& rhs )
        {
            for ( size_type i = 0; i < N; ++i )
            {
                d[ i ] = rhs.elem( i );
            }
            return *this;
        }

    vec< T, N >& operator=( const vec< T, N >& rhs )
    {
        for ( size_type i = 0; i < N; ++i )
        {
            d[ i ] = rhs.elem( i );
        }
        return *this;
    }

    vec< T, N >& operator=( const T& rhs )
    {
        std::fill_n( begin(), N, rhs );
        return *this;
    }

    void fill( const T& val )
    {
        std::fill_n( begin(), N, val );
    }

    void assign( const T& val )
    {
        std::fill_n( begin(), N, val );
    }

    //
    // Compound Assignment Operators
    // ---------------------------------------------------------------------
    //

#define ZI_VL_COMPOUND_OPERATOR_SCALAR( op )    \
                                                \
    vec< T, N >& operator op ( const T& rhs )   \
    {                                           \
        for ( size_type i = 0; i < N; ++i )     \
        {                                       \
            d[ i ] op rhs;                      \
        }                                       \
        return *this;                           \
    }

#define ZI_VL_COMPOUND_OPERATOR_TYPE( op )                      \
                                                                \
    template< class X >                                         \
    vec< T, N >& operator op ( const vec< X, N >& rhs )         \
    {                                                           \
        for ( size_type i = 0; i < N; ++i )                     \
        {                                                       \
            d[ i ] op rhs.elem( i );                            \
        }                                                       \
        return *this;                                           \
    }                                                           \
                                                                \
        vec< T, N >& operator op ( const vec< T, N >& rhs )     \
    {                                                           \
        for ( size_type i = 0; i < N; ++i )                     \
        {                                                       \
            d[ i ] op rhs.elem( i );                            \
        }                                                       \
        return *this;                                           \
    }

#define ZI_VL_COMPOUND_OPERATOR( op )           \
    ZI_VL_COMPOUND_OPERATOR_SCALAR( op )        \
    ZI_VL_COMPOUND_OPERATOR_TYPE( op )


    ZI_VL_COMPOUND_OPERATOR( += )
    ZI_VL_COMPOUND_OPERATOR( -= )
    ZI_VL_COMPOUND_OPERATOR( *= )

    ZI_VL_COMPOUND_OPERATOR_TYPE( /= )

#undef ZI_VL_COMPOUND_OPERATOR
#undef ZI_VL_COMPOUND_OPERATOR_SCALAR
#undef ZI_VL_COMPOUND_OPERATOR_TYPE

    vec< T, N >& operator/=( const T& rhs )
    {
        T rinv = static_cast< T >( 1 ) / rhs;
        for ( size_type i = 0; i < N; ++i )
        {
            d[ i ] *= rinv;
        }
        return *this;
    }

    //
    // Rest of the members
    // ---------------------------------------------------------------------
    //

public:

    static size_type size()
    {
        return N;
    }

    void swap( vec< T, N >& rhs )
    {
        for ( size_type i = 0; i < N; ++i )
        {
            ::std::swap( d[ i ], rhs.d[ i ] );
        }
    }

    static void rangecheck( size_type i )
    {
        if ( i >= N )
        {
            throw std::out_of_range( "vec<>: index out of range" );
        }
    }

    static const vec< T, N > one ;
    static const vec< T, N > zero;

};

template< class T, std::size_t N >
const vec< T, N > vec< T, N >::one( 1 );

template< class T, std::size_t N >
const vec< T, N > vec< T, N >::zero( 0 );


#define ZI_VL_TYPEDEF_VEC_TYPE( len )                   \
    typedef vec< int, len > vec##len##i;                \
    typedef vec< long, len > vec##len##l;               \
    typedef vec< long long, len > vec##len##ll;         \
    typedef vec< float, len > vec##len##f;              \
    typedef vec< double, len > vec##len##d;             \
    typedef vec< long double, len > vec##len##ld


ZI_VL_TYPEDEF_VEC_TYPE( 1 );
ZI_VL_TYPEDEF_VEC_TYPE( 2 );
ZI_VL_TYPEDEF_VEC_TYPE( 3 );
ZI_VL_TYPEDEF_VEC_TYPE( 4 );
ZI_VL_TYPEDEF_VEC_TYPE( 5 );
ZI_VL_TYPEDEF_VEC_TYPE( 6 );
ZI_VL_TYPEDEF_VEC_TYPE( 7 );
ZI_VL_TYPEDEF_VEC_TYPE( 8 );
ZI_VL_TYPEDEF_VEC_TYPE( 9 );
ZI_VL_TYPEDEF_VEC_TYPE( 10 );
ZI_VL_TYPEDEF_VEC_TYPE( 11 );
ZI_VL_TYPEDEF_VEC_TYPE( 12 );
ZI_VL_TYPEDEF_VEC_TYPE( 13 );
ZI_VL_TYPEDEF_VEC_TYPE( 14 );
ZI_VL_TYPEDEF_VEC_TYPE( 15 );
ZI_VL_TYPEDEF_VEC_TYPE( 16 );
ZI_VL_TYPEDEF_VEC_TYPE( 17 );
ZI_VL_TYPEDEF_VEC_TYPE( 18 );
ZI_VL_TYPEDEF_VEC_TYPE( 19 );
ZI_VL_TYPEDEF_VEC_TYPE( 20 );

#undef ZI_VL_TYPEDEF_VEC_TYPE


//
// Comparison
// ---------------------------------------------------------------------
//

template< class T, class O, std::size_t N >
inline bool operator==( const vec< T, N >& lhs,
                        const vec< O, N >& rhs )
{
    return std::equal( lhs.begin(), lhs.end(), rhs.begin() );
}

template< class T, std::size_t N >
inline bool operator==( const vec< T, N >& lhs,
                        const vec< T, N >& rhs )
{
    return std::equal( lhs.begin(), lhs.end(), rhs.begin() );
}

template< class T, class O, std::size_t N >
inline bool operator!=( const vec< T, N >& lhs,
                        const vec< O, N >& rhs )
{
    return !( lhs == rhs );
}

template< class T, std::size_t N >
inline bool operator!=( const vec< T, N >& lhs,
                        const vec< T, N >& rhs )
{
    return !( lhs == rhs );
}

template< class T, class O, std::size_t N >
inline bool operator<( const vec< T, N >& lhs,
                       const vec< O, N >& rhs )
{
    return std::lexicographical_compare( lhs.begin(), lhs.end(),
                                         rhs.begin(), rhs.end() );
}

template< class T, std::size_t N >
inline bool operator<( const vec< T, N >& lhs,
                       const vec< T, N >& rhs )
{
    return std::lexicographical_compare( lhs.begin(), lhs.end(),
                                         rhs.begin(), rhs.end() );
}

template< class T, class O, std::size_t N >
inline bool operator>( const vec< T, N >& lhs,
                       const vec< O, N >& rhs )
{
    return ( rhs < lhs );
}

template< class T, std::size_t N >
inline bool operator>( const vec< T, N >& lhs,
                       const vec< T, N >& rhs )
{
    return ( rhs < lhs );
}

template< class T, class O, std::size_t N >
inline bool operator<=( const vec< T, N >& lhs,
                        const vec< O, N >& rhs )
{
    return !( rhs < lhs );
}

template< class T, std::size_t N >
inline bool operator<=( const vec< T, N >& lhs,
                        const vec< T, N >& rhs )
{
    return !( rhs < lhs );
}

template< class T, class O, std::size_t N >
inline bool operator>=( const vec< T, N >& lhs,
                        const vec< O, N >& rhs )
{
    return !( lhs < rhs );
}

template< class T, std::size_t N >
inline bool operator>=( const vec< T, N >& lhs,
                        const vec< T, N >& rhs )
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
    typename vec< T, N >::type                                  \
    operator op( const T& lhs, const vec< T, N >& rhs )         \
    {                                                           \
        vec< T, N >res( lhs );                                  \
        res op##= rhs;                                          \
        return res;                                             \
    }                                                           \
                                                                \
    template< class T, class O, std::size_t N >                 \
    inline                                                      \
    typename detail::enable_if                                  \
    < is_scalar< T >,                                           \
      vec< typename detail::promote< O, T >::type, N > >::type  \
    operator op( const T& lhs, const vec< O, N >& rhs )         \
    {                                                           \
        vec< typename detail::promote< O, T >::type, N >        \
            res( lhs );                                         \
        res op##= rhs;                                          \
        return res;                                             \
    }


#define ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( op )                  \
                                                                        \
    template< class O, class T, std::size_t N >                         \
    inline                                                              \
    typename detail::enable_if                                          \
    < is_scalar< O >,                                                   \
      vec< typename detail::promote< O, T >::type, N > >::type          \
    operator op( const vec< T, N >& lhs, const O& rhs )                 \
    {                                                                   \
        vec< typename detail::promote< O, T >::type, N > res( lhs );    \
        res op##= rhs;                                                  \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T, std::size_t N >                                  \
    inline                                                              \
    vec< T, N >                                                         \
    operator op( const vec< T, N >& lhs, const T& rhs )                 \
    {                                                                   \
        vec< T, N > res( lhs );                                         \
        res op##= rhs;                                                  \
        return res;                                                     \
    }

#define ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE( op )                    \
    template< class T, class O, std::size_t N >                         \
    inline                                                              \
    vec< typename detail::promote< O, T >::type, N >                    \
    operator op( const vec< T, N >& lhs, const vec< O, N >& rhs )       \
    {                                                                   \
        vec< typename detail::promote< O, T >::type, N > res( lhs );    \
        res op##= rhs;                                                  \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T, std::size_t N >                                  \
    inline                                                              \
    typename vec< T, N >::type                                          \
    operator op( const vec< T, N >& lhs, const vec< T, N >& rhs )       \
    {                                                                   \
        vec< T, N > res( lhs );                                         \
        res op##= rhs;                                                  \
        return res;                                                     \
    }


#define ZI_VL_INLINE_BINARY_OPERATOR( op )              \
    ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( op )      \
    ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE( op )      \
    ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE( op )


ZI_VL_INLINE_BINARY_OPERATOR( + )
ZI_VL_INLINE_BINARY_OPERATOR( - )
ZI_VL_INLINE_BINARY_OPERATOR( * )
ZI_VL_INLINE_BINARY_OPERATOR( / )

#undef ZI_VL_INLINE_BINARY_OPERATOR
#undef ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE
#undef ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE
#undef ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR

template< class T, std::size_t N >
inline
vec< T, N > operator+( const vec< T, N >& rhs )
{
    return rhs;
}

template< class T, std::size_t N >
inline
vec< T, N > operator-( const vec< T, N >& rhs )
{
    vec< T, N > res( rhs );
    for ( std::size_t i = 0; i < N; ++i )
    {
        res[ i ] = -rhs.elem( i );
    }
    return res;
}

template< class T, std::size_t N, class CharT, class Traits >
::std::basic_ostream< CharT, Traits >&
operator<<( ::std::basic_ostream< CharT, Traits >& os,
            const vec< T, N >& v )
{
    os << "[ " << v[ 0 ];
    for ( std::size_t i = 1; i < N; ++i )
    {
        os << ", " << v[ i ];
    }
    return os << " ]";
}

template< std::size_t I, class T, std::size_t N >
inline const T& get( const vec< T, N >& v )
{
    return v.template get< I >();
}

template< std::size_t I, class T, std::size_t N >
inline T& get( vec< T, N >& v )
{
    return v.template get< I >();
}

} // namespace vl
} // namespace zi


// provide functionality

#include <zi/vl/vec_functions.hpp>

#endif
