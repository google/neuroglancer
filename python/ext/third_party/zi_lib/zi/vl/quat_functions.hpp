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

#ifndef ZI_VL_QUAT_FUNCTIONS_HPP
#define ZI_VL_QUAT_FUNCTIONS_HPP 1

#include <zi/vl/quat.hpp>

namespace zi {
namespace vl {

template< class T >
inline void conjugate( quat< T >& q )
{
    q.at( 0 ) = -q.at( 0 );
    q.at( 1 ) = -q.at( 1 );
    q.at( 2 ) = -q.at( 2 );
}

template< class T >
inline quat< T > conj( const quat< T >& q )
{
    return quat< T >( -q.at( 0 ), -q.at( 1 ), -q.at( 2 ), q.at( 3 ) );
}

template< class T >
inline T squared_length( const quat< T >& q )
{
    return
        q.at( 0 ) * q.at( 0 ) +
        q.at( 1 ) * q.at( 1 ) +
        q.at( 2 ) * q.at( 2 ) +
        q.at( 3 ) * q.at( 3 );
}

template< class T >
inline T sqrlen( const quat< T >& q )
{
    return
        q.at( 0 ) * q.at( 0 ) +
        q.at( 1 ) * q.at( 1 ) +
        q.at( 2 ) * q.at( 2 ) +
        q.at( 3 ) * q.at( 3 );
}

template< class T >
inline T length( const quat< T >& q )
{
    return std::sqrt( sqrlen( q ) );
}

template< class T >
inline T len( const quat< T >& q )
{
    return std::sqrt( sqrlen( q ) );
}

template< class T >
inline T abs( const quat< T >& q )
{
    return std::sqrt( sqrlen( q ) );
}

template< class T >
inline
T invert( quat< T >& q )
{
    T l = sqrlen( q );

    if ( l <= std::numeric_limits< T >::epsilon() )
    {
        return 0;
    }

    T invl = static_cast< T >( 1 ) / l;
    conjugate( q );
    q *= invl;

    return l;
}

template< class T >
inline
quat< T > inv( const quat< T >& q, bool& ok )
{
    quat< T > tmp( q );
    ok = invert( tmp );
    return tmp;
}

template< class T >
inline
quat< T > inv( const quat< T >& q )
{
    quat< T > tmp( q );
    if ( !static_cast< bool >( invert( tmp ) ) )
    {
        throw ::std::runtime_error( "quat<>: inverting singular quaternion" );
    }
    return tmp;
}

template< class T >
inline
T normalize( quat< T >& q )
{
    T l = length( q );
    if ( l <= std::numeric_limits< T >::epsilon() )
    {
        return 0;
    }

    T invl = static_cast< T >( 1 ) / l;
    q *= invl;

    return l;
}

template< class T >
inline
quat< T > norm( const quat< T >& q )
{
    quat< T > tmp( q );
    normalize( tmp );
    return tmp;
}

template< class T, class O >
inline
typename detail::promote< T, O >::type
dot( const quat< T >& lhs, const quat< O >& rhs )
{
    typedef typename detail::promote< T >::type promoted_type;

    return
        static_cast< promoted_type >( lhs.at( 0 ) ) * rhs.at( 0 ) +
        static_cast< promoted_type >( lhs.at( 1 ) ) * rhs.at( 1 ) +
        static_cast< promoted_type >( lhs.at( 2 ) ) * rhs.at( 2 ) +
        static_cast< promoted_type >( lhs.at( 3 ) ) * rhs.at( 3 );
}


template< class T >
inline
T
dot( const quat< T >& lhs, const quat< T >& rhs )
{
    return
        lhs.at( 0 ) * rhs.at( 0 ) +
        lhs.at( 1 ) * rhs.at( 1 ) +
        lhs.at( 2 ) * rhs.at( 2 ) +
        lhs.at( 3 ) * rhs.at( 3 );
}

template< class T, class O >
inline
vec< typename detail::promote< T, O >::type, 3 >
cross( const quat< T >& lhs, const quat< O >& rhs )
{
    typedef typename detail::promote< T >::type promoted_type;

    return vec< promoted_type, 3 >
        ( static_cast< promoted_type >( lhs.at( 1 ) ) * rhs.at( 2 ) -
          static_cast< promoted_type >( lhs.at( 2 ) ) * rhs.at( 1 ),
          static_cast< promoted_type >( lhs.at( 2 ) ) * rhs.at( 0 ) -
          static_cast< promoted_type >( lhs.at( 0 ) ) * rhs.at( 2 ),
          static_cast< promoted_type >( lhs.at( 0 ) ) * rhs.at( 1 ) -
          static_cast< promoted_type >( lhs.at( 1 ) ) * rhs.at( 0 ) );
}


template< class T >
inline
vec< T, 3 >
cross( const quat< T >& lhs, const quat< T >& rhs )
{
    return vec< T, 3 >
        ( lhs.at( 1 ) * rhs.at( 2 ) -
          lhs.at( 2 ) * rhs.at( 1 ),
          lhs.at( 2 ) * rhs.at( 0 ) -
          lhs.at( 0 ) * rhs.at( 2 ),
          lhs.at( 0 ) * rhs.at( 1 ) -
          lhs.at( 1 ) * rhs.at( 0 ) );
}

template< class T >
inline
quat< T >
cross( const quat< T >& q0, const quat< T >& q1, const quat< T >& q2 )
{
    quat< T > res;

    res[ 0 ] =
        q0[ 1 ] * ( q1[ 2 ] * q2[ 3 ] - q1[ 3 ] * q2[ 2 ] ) +
        q1[ 1 ] * ( q2[ 2 ] * q0[ 3 ] - q2[ 3 ] * q0[ 2 ] ) +
        q2[ 1 ] * ( q0[ 2 ] * q1[ 3 ] - q0[ 3 ] * q1[ 2 ] ) ;

    res[ 1 ] =
        q0[ 0 ] * ( q1[ 2 ] * q2[ 3 ] - q1[ 3 ] * q2[ 2 ] ) +
        q1[ 0 ] * ( q2[ 2 ] * q0[ 3 ] - q2[ 3 ] * q0[ 2 ] ) +
        q2[ 0 ] * ( q0[ 2 ] * q1[ 3 ] - q0[ 3 ] * q1[ 2 ] ) ;

    res[ 2 ] =
        q0[ 0 ] * ( q1[ 1 ] * q2[ 3 ] - q1[ 3 ] * q2[ 1 ] ) +
        q1[ 0 ] * ( q2[ 1 ] * q0[ 3 ] - q2[ 3 ] * q0[ 1 ] ) +
        q2[ 0 ] * ( q0[ 1 ] * q1[ 3 ] - q0[ 3 ] * q1[ 1 ] );

    res[ 3 ] =
        q0[ 0 ] * ( q1[ 1 ] * q2[ 2 ] - q1[ 2 ] * q2[ 1 ] ) +
        q1[ 0 ] * ( q2[ 1 ] * q0[ 2 ] - q2[ 2 ] * q0[ 1 ] ) +
        q2[ 0 ] * ( q0[ 1 ] * q1[ 2 ] - q0[ 2 ] * q1[ 1 ] );

    return res;
}

template< class T, class O, class W >
inline
quat< typename detail::promote< T, O, W >::type >
cross( const quat< T >& q0, const quat< O >& q1, const quat< W >& q2 )
{
    typedef typename detail::promote< T, O, W >::type promoted_type;

    quat< promoted_type > q0a( q0 );
    quat< promoted_type > q1a( q1 );
    quat< promoted_type > q2a( q2 );

    return cross( q0a, q1a, q2a );
}

template< class T >
inline
quat< T >
normal( const quat< T >& qa, const quat< T >& qb,
        const quat< T >& qc, const quat< T >& qd )
{
    quat< T > quat_t( qb - qa );
    quat< T > quat_u( qc - qa );
    quat< T > quat_v( qd - qa );
    quat< T > res = cross( quat_t, quat_u, quat_v );
    normalize( res );
    return res;
}

template< class X, class Y, class Z, class W >
inline
quat< typename detail::promote< X, Y, Z, W >::type >
normal( const quat< X >& qa, const quat< Y >& qb,
        const quat< Z >& qc, const quat< W >& qd )
{
    typedef typename detail::promote< X, Y, Z, W >::type promoted_type;
    quat< promoted_type > quat_t( qb ); quat_t -= qa;
    quat< promoted_type > quat_u( qc ); quat_u -= qa;
    quat< promoted_type > quat_v( qd ); quat_v -= qa;

    quat< promoted_type > res = cross( quat_t, quat_u, quat_v );
    normalize( res );
    return res;
}

template< class T, class O >
inline
quat< T >& operator/=( quat< T >& lhs, const quat< O >& rhs )
{
    quat< T > invrhs = inv( rhs );
    lhs *= invrhs;
    return lhs;
}

template< class T >
inline
quat< T >& operator/=( quat< T >& lhs, const quat< T >& rhs )
{
    quat< T > invrhs = inv( rhs );
    lhs *= invrhs;
    return lhs;
}


template< class T, class O >
inline
quat< typename detail::promote< T, O >::type >
slerp( const T& a, const quat< T >& p, const quat< O >& q )
{
    typedef typename detail::promote< T, O >::type promoted_type;
    quat< promoted_type > np = norm( p );
    quat< promoted_type > nq = norm( q );

    T cosine = dot( np, nq );

    quat< promoted_type > quat_t( q );

    if ( cosine < 0 )
    {
        cosine = -cosine;
        quat_t = -quat_t;
    }

    if ( static_cast< T >( 1 ) - std::abs( cosine )
         > std::numeric_limits< T >::epsilon() )
    {
        T sine    = std::sqrt( static_cast< T >( 1 ) - cosine * cosine );
        T invsine = static_cast< T >( 1 ) / sine;
        T angle   = std::atan2( sine, cosine );
        T coeffp  = std::sin( ( static_cast< T >( 1 ) - a ) * angle ) * invsine;
        T coeffq  = std::sin( a * angle ) * invsine;
        return coeffp * p + coeffq * quat_t;
    }
    else
    {
        return norm( ( static_cast< T >( 1 ) - a ) * p + a * quat_t );
    }
}

template< class T >
inline
quat< T >
slerp( const T& a, const quat< T >& p, const quat< T >& q )
{
    quat< T > np = norm( p );
    quat< T > nq = norm( q );

    T cosine = dot( np, nq );

    quat< T > quat_t( q );

    if ( cosine < 0 )
    {
        cosine = -cosine;
        quat_t = -quat_t;
    }

    if ( static_cast< T >( 1 ) - std::abs( cosine )
         > std::numeric_limits< T >::epsilon() )
    {
        T sine    = std::sqrt( static_cast< T >( 1 ) - cosine * cosine );
        T invsine = static_cast< T >( 1 ) / sine;
        T angle   = std::atan2( sine, cosine );
        T coeffp  = std::sin( ( static_cast< T >( 1 ) - a ) * angle ) * invsine;
        T coeffq  = std::sin( a * angle ) * invsine;
        return coeffp * p + coeffq * quat_t;
    }
    else
    {
        return norm( ( static_cast< T >( 1 ) - a ) * p + a * quat_t );
    }
}

} // namespace vl
} // namespace zi

#endif
