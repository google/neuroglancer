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

#ifndef ZI_VL_VEC_FUNCTIONS_HPP
#define ZI_VL_VEC_FUNCTIONS_HPP 1

#include <cmath>
#include <zi/vl/vec.hpp>

namespace zi {
namespace vl {

template< class T, std::size_t N >
inline typename detail::promote< T >::type
squared_length( const vec< T, N >& v )
{
    typedef typename detail::promote< T >::type promoted_type;
    promoted_type r = static_cast< promoted_type >( 0 );
    for ( std::size_t i = 0; i < N; ++i )
    {
        r += static_cast< promoted_type >( v[ i ] ) * v[ i ];
    }
    return r;
}

template< class T, std::size_t N >
inline typename detail::promote< T >::type
sqrlen( const vec< T, N >& v )
{
    typedef typename detail::promote< T >::type promoted_type;
    promoted_type r = static_cast< promoted_type >( 0 );
    for ( std::size_t i = 0; i < N; ++i )
    {
        r += static_cast< promoted_type >( v[ i ] ) * v[ i ];
    }
    return r;
}

template< class T, std::size_t N >
inline typename detail::promote< T >::type
length( const vec< T, N >& v )
{
    return std::sqrt( sqrlen( v ) );
}

template< class T, std::size_t N >
inline typename detail::promote< T >::type
len( const vec< T, N >& v )
{
    return std::sqrt( sqrlen( v ) );
}

template< class T, std::size_t N >
inline
typename detail::enable_if<
    is_floating_point< T >
    , T >::type
normalize( vec< T, N >& v )
    {
        T r = static_cast< T >( 1 ) / length( v );
        v *= r;
        return r;
    }

template< class T, std::size_t N >
inline
vec< typename detail::promote< T >::type, N >
norm( const vec< T, N >& v )
{
    vec< typename detail::promote< T >::type, N > res( v );
    normalize( res );
    return res;
}

template< class T, class O, std::size_t N >
inline
typename detail::promote< T, O >::type
squared_distance( const vec< T, N >& v1, const vec< O, N >& v2 )
{
    typedef typename detail::promote< T, O >::type promoted_type;
    promoted_type r = static_cast< promoted_type >( 0 );
    for ( std::size_t i = 0; i < N; ++i )
    {
        promoted_type d = v1[ i ];
        d -= v2[ i ];
        r += d * d;
    }
    return r;
}

template< class T, std::size_t N >
inline
typename detail::promote< T >::type
squared_distance( const vec< T, N >& v1, const vec< T, N >& v2 )
{
    typedef typename detail::promote< T >::type promoted_type;
    promoted_type r = static_cast< promoted_type >( 0 );
    for ( std::size_t i = 0; i < N; ++i )
    {
        promoted_type d = v1[ i ];
        d -= v2[ i ];
        r += d * d;
    }
    return r;
}


template< class T, class O, std::size_t N >
inline
typename detail::promote< T, O >::type
distance( const vec< T, N >& v1, const vec< O, N >& v2 )
{
    return std::sqrt( squared_distance( v1, v2 ) );
}

template< class T, std::size_t N >
inline
typename detail::promote< T >::type
distance( const vec< T, N >& v1, const vec< T, N >& v2 )
{
    return std::sqrt( squared_distance( v1, v2 ) );
}

template< class T, std::size_t N >
inline
void clamp( vec< T, N >& v, const T& min = T( 0 ), const T& max = T( 1 ) )
{
    for ( std::size_t i = 0; i < N; ++i )
    {
        v[ i ] = ( v[ i ] < min ? min : ( v[ i ] > max ? max : v[ i ] ) );
    }
}

template< class T >
inline
typename detail::enable_if< is_signed< T >, vec< T, 2 > >::type
cross( const vec< T, 2 >& v )
{
    vec< T, 2 > res;
    res[ 0 ] = v[ 1 ];
    res[ 1 ] = -v[ 0 ];
    return res;
}

template< class T >
inline
typename detail::enable_if< is_signed< T >, vec< T, 3 > >::type
cross( const vec< T, 3 >& v1, const vec< T, 3 >& v2 )
{
    vec< T, 3 > res;
    res[ 0 ] = v1[ 1 ] * v2[ 2 ] - v1[ 2 ] * v2[ 1 ];
    res[ 1 ] = v1[ 2 ] * v2[ 0 ] - v1[ 0 ] * v2[ 2 ];
    res[ 2 ] = v1[ 0 ] * v2[ 1 ] - v1[ 1 ] * v2[ 0 ];
    return res;
}

template< class T, class O >
inline
vec< typename detail::promote< T, O >::type, 3 >
cross( const vec< T, 3 >& v1, const vec< O, 3 >& v2 )
{
    typedef typename detail::promote< T >::type promoted_type;
    vec< promoted_type, 3 > res;

    res[ 0 ] =
        static_cast< promoted_type >( v1[ 1 ] ) * v2[ 2 ] -
        static_cast< promoted_type >( v1[ 2 ] ) * v2[ 1 ];

    res[ 1 ] =
        static_cast< promoted_type >( v1[ 2 ] ) * v2[ 0 ] -
        static_cast< promoted_type >( v1[ 0 ] ) * v2[ 2 ];

    res[ 2 ] =
        static_cast< promoted_type >( v1[ 0 ] ) * v2[ 1 ] -
        static_cast< promoted_type >( v1[ 1 ] ) * v2[ 0 ];

    return res;
}

template< class T >
inline
typename detail::enable_if< is_signed< T >, vec< T, 4 > >::type
cross( const vec< T, 4 >& v0, const vec< T, 4 >& v1, const vec< T, 4 >& v2 )
{
    vec< T, 4 > res;

    res[ 0 ] =
        v0[ 1 ] * ( v1[ 2 ] * v2[ 3 ] - v1[ 3 ] * v2[ 2 ] ) +
        v1[ 1 ] * ( v2[ 2 ] * v0[ 3 ] - v2[ 3 ] * v0[ 2 ] ) +
        v2[ 1 ] * ( v0[ 2 ] * v1[ 3 ] - v0[ 3 ] * v1[ 2 ] ) ;

    res[ 1 ] =
        v0[ 0 ] * ( v1[ 2 ] * v2[ 3 ] - v1[ 3 ] * v2[ 2 ] ) +
        v1[ 0 ] * ( v2[ 2 ] * v0[ 3 ] - v2[ 3 ] * v0[ 2 ] ) +
        v2[ 0 ] * ( v0[ 2 ] * v1[ 3 ] - v0[ 3 ] * v1[ 2 ] ) ;

    res[ 2 ] =
        v0[ 0 ] * ( v1[ 1 ] * v2[ 3 ] - v1[ 3 ] * v2[ 1 ] ) +
        v1[ 0 ] * ( v2[ 1 ] * v0[ 3 ] - v2[ 3 ] * v0[ 1 ] ) +
        v2[ 0 ] * ( v0[ 1 ] * v1[ 3 ] - v0[ 3 ] * v1[ 1 ] );

    res[ 3 ] =
        v0[ 0 ] * ( v1[ 1 ] * v2[ 2 ] - v1[ 2 ] * v2[ 1 ] ) +
        v1[ 0 ] * ( v2[ 1 ] * v0[ 2 ] - v2[ 2 ] * v0[ 1 ] ) +
        v2[ 0 ] * ( v0[ 1 ] * v1[ 2 ] - v0[ 2 ] * v1[ 1 ] );

    return res;
}

template< class T, class O, class W >
inline
vec< typename detail::promote< T, O, W >::type, 4 >
cross( const vec< T, 4 >& v0, const vec< O, 4 >& v1, const vec< W, 4 >& v2 )
{
    typedef typename detail::promote< T, O, W >::type promoted_type;

    vec< promoted_type, 4 > v0a( v0 );
    vec< promoted_type, 4 > v1a( v1 );
    vec< promoted_type, 4 > v2a( v2 );

    return cross( v0a, v1a, v2a );
}

template< class T, class O, std::size_t N >
inline
typename detail::promote< T, O >::type
dot( const vec< T, N >& v1, const vec< O, N >& v2 )
{
    typedef typename detail::promote< T, O >::type promoted_type;
    promoted_type r = static_cast< promoted_type >( 0 );
    for ( std::size_t i = 0; i < N; ++i )
    {
        r += static_cast< promoted_type >( v1[ i ] ) * v2[ i ];
    }
    return r;
}

template< class T, std::size_t N >
inline
typename detail::promote< T >::type
dot( const vec< T, N >& v1, const vec< T, N >& v2 )
{
    typedef typename detail::promote< T >::type promoted_type;
    promoted_type r = static_cast< promoted_type >( 0 );
    for ( std::size_t i = 0; i < N; ++i )
    {
        r += static_cast< promoted_type >( v1[ i ] ) * v2[ i ];
    }
    return r;
}

template< class X, class Y, class Z, std::size_t N >
inline
vec< typename detail::promote< X, Y, Z >::type, N >
normal( const vec< X, N >& v1, const vec< Y, N >& v2, const vec< Z, N >& v3 )
{
    return norm( cross( v2 - v1, v3 - v1 ) );
}

template< class T, std::size_t N >
inline
vec< typename detail::promote< T >::type, N >
normal( const vec< T, N >& v1, const vec< T, N >& v2, const vec< T, N >& v3 )
{
    return norm( cross( v2 - v1, v3 - v1 ) );
}


template< class T, class O, std::size_t N >
inline
vec< typename detail::promote< T, O >::type, N >
slerp( const vec< T, N >& p, const vec< O, N >& q, const T& a )
{
    typedef typename detail::promote< T, O >::type PT;
    PT cosine = dot( norm( p ), norm( q ) );

    vec< PT, N > b( q );

    if ( cosine < 0 )
    {
        cosine = -cosine;
        b      = -b;
    }

    if ( static_cast< T >( 1 ) - std::abs( cosine )
         > std::numeric_limits< T >::epsilon() )
    {
        PT sine    = std::sqrt( static_cast< PT >( 1 ) - cosine * cosine );
        PT invsine = static_cast< PT >( 1 ) / sine;
        PT angle   = std::atan2( sine, cosine );
        PT coeffp  = std::sin( ( static_cast< PT >( 1 ) - a ) * angle ) * invsine;
        PT coeffq  = std::sin( a * angle ) * invsine;
        return coeffp * p + coeffq * b;
    }
    else
    {
        return norm( ( static_cast< PT >( 1 ) - a ) * p + a * b );
    }
}


template< class T, std::size_t N >
inline
vec< typename detail::promote< T >::type, N >
slerp( const vec< T, N >& p, const vec< T, N >& q, const T& a )
{
    typedef typename detail::promote< T >::type PT;
    PT cosine = dot( norm( p ), norm( q ) );

    vec< PT, N > b( q );

    if ( cosine < 0 )
    {
        cosine = -cosine;
        b      = -b;
    }

    if ( static_cast< T >( 1 ) - std::abs( cosine )
         > std::numeric_limits< T >::epsilon() )
    {
        PT sine    = std::sqrt( static_cast< PT >( 1 ) - cosine * cosine );
        PT invsine = static_cast< PT >( 1 ) / sine;
        PT angle   = std::atan2( sine, cosine );
        PT coeffp  = std::sin( ( static_cast< PT >( 1 ) - a ) * angle ) * invsine;
        PT coeffq  = std::sin( a * angle ) * invsine;
        return coeffp * p + coeffq * b;
    }
    else
    {
        return norm( ( static_cast< PT >( 1 ) - a ) * p + a * b );
    }
}

#define ZI_VL_INNER_PRODUCT_IMPL( name )                                \
                                                                        \
    template< class T, class O, std::size_t N >                         \
    inline                                                              \
    vec< typename detail::promote< T, O >::type, N >                    \
    name ( const vec< T, N >& v1, const vec< O, N >& v2 )               \
    {                                                                   \
        typedef typename detail::promote< T, O >::type promoted_type;   \
        vec< promoted_type, N > res;                                    \
                                                                        \
        for ( std::size_t i = 0; i < N; ++i )                           \
        {                                                               \
            res.at( i ) = static_cast< promoted_type >                  \
                ( v1.at( i ) ) * v2.at( i );                            \
        }                                                               \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T, std::size_t N >                                  \
    inline                                                              \
    vec< T, N >                                                         \
    name ( const vec< T, N >& v1, const vec< T, N >& v2 )               \
    {                                                                   \
        vec< T, N > res;                                                \
                                                                        \
        for ( std::size_t i = 0; i < N; ++i )                           \
        {                                                               \
            res.at( i ) = v1.at( i ) * v2.at( i );                      \
        }                                                               \
        return res;                                                     \
    }


ZI_VL_INNER_PRODUCT_IMPL( iprod )
ZI_VL_INNER_PRODUCT_IMPL( inner_product )

#undef ZI_VL_INNER_PRODUCT_IMPL


template< class T, class X, std::size_t N >
inline
typename detail::enable_if<
    is_scalar< X >,
    vec< typename detail::promote< T, X >::type, N+1 >
    >::type
operator,( const vec< T, N >& vl, const X& v )
{
    typedef typename detail::promote< T, X >::type promoted_type;
    return vec< promoted_type, N+1 >( vl, static_cast< promoted_type >( v ) );
}

template< class T, std::size_t N >
inline
vec< T, N+1 >
operator,( const vec< T, N >& vl, const T& v )
{
    return vec< T, N+1 >( vl, v );
}

template< class X, class T, std::size_t N >
inline
typename detail::enable_if<
    is_scalar< X >
    , vec< typename detail::promote< T, X >::type, N+1 >
    >::type
    operator,( const X& v, const vec< T, N >& vr )
{
    typedef typename detail::promote< T, X >::type promoted_type;
    return vec< promoted_type, N+1 >( static_cast< promoted_type >( v ), vr );
}

template< class T, std::size_t N >
inline
vec< T, N+1 >
operator,( const T& v, const vec< T, N >& vr )
{
    return vec< T, N+1 >( v, vr );
}

template< class X, std::size_t N, class T, std::size_t M >
inline
vec< typename detail::promote< T, X >::type, N+M >
operator,( const vec< X, N >& vl, const vec< T, M >& vr )
{
    typedef typename detail::promote< T, X >::type promoted_type;
    return vec< promoted_type, N+M >( vl, vr );
}

template< class T, std::size_t N, std::size_t M >
inline
vec< T, N+M >
operator,( const vec< T, N >& vl, const vec< T, M >& vr )
{
    return vec< T, N+M >( vl, vr );
}


} // namespace vl
} // namespace zi

#endif
