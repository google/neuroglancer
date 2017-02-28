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

#ifndef ZI_MESH_DETAIL_QUADRATIC_HPP
#define ZI_MESH_DETAIL_QUADRATIC_HPP 1

#include <zi/vl/vec.hpp>
#include <zi/vl/mat.hpp>

#include <zi/utility/assert.hpp>
#include <zi/utility/static_assert.hpp>

#include <zi/bits/type_traits.hpp>

#include <ostream>
#include <iomanip>

namespace zi {
namespace mesh {
namespace detail {

template< class T >
class quadratic
{
private:
    ZI_STATIC_ASSERT( is_floating_point< T >::value , non_floating_point_quadratic );

protected:
    T    a2,   ab,   ac,   ad;
    T /* ab,*/ b2,   bc,   bd;
    T /* ac,   bc,*/ c2,   cd;
    T /* ad,   bd,   cd,*/ d2;

public:

    inline T offset() const
    {
        return d2;
    }

    inline zi::vl::vec< T, 3 > vector() const
    {
        return zi::vl::vec< T, 3 >( ad, bd, cd );
    }

private:
    inline void init( const T &a, const T &b, const T &c, const T &d )
    {
        a2 = a * a; b2 = b * b; c2 = c * c; d2 = d * d;
        ab = a * b; ac = a * c; ad = a * d;
        bc = b * c; bd = b * d;
        cd = c * d;
    }

    template< class Y >
    inline void init( const zi::vl::mat< Y, 4 > &m )
    {
        a2 = static_cast< T >( m.at( 0, 0 ) );
        ab = static_cast< T >( m.at( 0, 1 ) );
        ac = static_cast< T >( m.at( 0, 2 ) );
        ad = static_cast< T >( m.at( 0, 3 ) );
        b2 = static_cast< T >( m.at( 1, 1 ) );
        bc = static_cast< T >( m.at( 1, 2 ) );
        bd = static_cast< T >( m.at( 1, 3 ) );
        c2 = static_cast< T >( m.at( 2, 2 ) );
        cd = static_cast< T >( m.at( 2, 3 ) );
        d2 = static_cast< T >( m.at( 3, 3 ) );
    }

    inline void init( const zi::vl::mat< T, 4 > &m )
    {
        a2 = m.at( 0, 0 );
        ab = m.at( 0, 1 );
        ac = m.at( 0, 2 );
        ad = m.at( 0, 3 );
        b2 = m.at( 1, 1 );
        bc = m.at( 1, 2 );
        bd = m.at( 1, 3 );
        c2 = m.at( 2, 2 );
        cd = m.at( 2, 3 );
        d2 = m.at( 3, 3 );
    }


public:

    explicit quadratic( const T &a = T(),
                        const T &b = T(),
                        const T &c = T(),
                        const T &d = T() )
    {
        init( a, b, c, d );
    }

    template< class Y >
    explicit quadratic( const quadratic< Y >& o )
    {
        *this = o;
    }

    template< class Y >
    explicit quadratic( const zi::vl::mat< Y, 4 >& o )
    {
        init( o );
    }

    explicit quadratic( const zi::vl::mat< T, 4 >& o )
    {
        init( o );
    }


#define ZI_QUADRATIC_COMPOUND_OPERATOR( op )                    \
                                                                \
    template< class Y >                                         \
    quadratic< T >& operator op( const quadratic< Y >& x )      \
    {                                                           \
        a2 op static_cast< T >( x.a2 );                         \
        b2 op static_cast< T >( x.b2 );                         \
        c2 op static_cast< T >( x.c2 );                         \
        d2 op static_cast< T >( x.d2 );                         \
        ab op static_cast< T >( x.ab );                         \
        ac op static_cast< T >( x.ac );                         \
        ad op static_cast< T >( x.ad );                         \
        bc op static_cast< T >( x.bc );                         \
        bd op static_cast< T >( x.bd );                         \
        cd op static_cast< T >( x.cd );                         \
        return *this;                                           \
    }                                                           \
                                                                \
        quadratic< T >& operator op( const quadratic< T >& x )  \
    {                                                           \
        a2 op x.a2;                                             \
        b2 op x.b2;                                             \
        c2 op x.c2;                                             \
        d2 op x.d2;                                             \
        ab op x.ab;                                             \
        ac op x.ac;                                             \
        ad op x.ad;                                             \
        bc op x.bc;                                             \
        bd op x.bd;                                             \
        cd op x.cd;                                             \
        return *this;                                           \
    }


    ZI_QUADRATIC_COMPOUND_OPERATOR( =  );
    ZI_QUADRATIC_COMPOUND_OPERATOR( -= );
    ZI_QUADRATIC_COMPOUND_OPERATOR( += );

#undef ZI_QUADRATIC_COMPOUND_OPERATOR

    quadratic< T >& operator*=( const T& c )
    {
        a2 *= c; b2 *= c; c2 *= c; d2 *= c;
        ab *= c; ac *= c; ad *= c;
        bc *= c; bd *= c;
        cd *= c;
        return *this;
    }

    T evaluate( const T& x, const T& y, const T& z ) const
    {
        return ( x * ( x * a2 + ( y * ab + z * ac + ad ) * 2.0 ) +
                 y * ( y * b2 + ( z * bc + bd ) * 2.0 ) +
                 z * ( z * c2 + cd * 2.0 ) +
                 d2 );

    }

    template< class Y >
    T evaluate( const zi::vl::vec< Y, 3 >& v ) const
    {
        return evaluate( v.at( 0 ), v.at( 1 ), v.at( 2 ) );
    }

    T evaluate( const zi::vl::vec< T, 3 >& v ) const
    {
        return evaluate( v.at( 0 ), v.at( 1 ), v.at( 2 ) );
    }

    T operator()( const T& x, const T& y, const T& z ) const
    {
        return evaluate( x, y, z );
    }

    template< class Y >
    T operator()( const zi::vl::vec< Y, 3 >& v ) const
    {
        return evaluate( v.at( 0 ), v.at( 1 ), v.at( 2 ) );
    }

    T operator()( const zi::vl::vec< T, 3 >& v ) const
    {
        return evaluate( v.at( 0 ), v.at( 1 ), v.at( 2 ) );
    }

    zi::vl::mat< T, 3 > tensor() const
    {
        return zi::vl::mat< T, 3 >( a2, ab, ac, ab, b2, bc, ac, bc, c2 );
    }

    zi::vl::mat< T, 4 > homogenous() const
    {
        return zi::vl::mat< T, 4 >( a2, ab, ac, ad,
                                    ab, b2, bc, bd,
                                    ac, bc, c2, cd,
                                    ad, bd, cd, d2 );
    }

    void clear( const T& x = 0 )
    {
        a2 = ab = ac = ad = b2 = bc = bd = c2 = cd = d2 = x;
    }

    bool optimize( zi::vl::vec< T, 3 >& v ) const
    {
        zi::vl::mat< T, 3 > ainv( a2, ab, ac,
                                  ab, b2, bc,
                                  ac, bc, c2 );

        if ( zi::vl::invert( ainv ) )
        {
            v = -( ainv * zi::vl::vec< T, 3 >( ad, bd, cd ) );
            return true;
        }
        return false;
    }

    bool optimize( T &x, T& y, T& z )
    {
        zi::vl::vec< T, 3 > v;
        if ( optimize( v ) )
        {
            x = v.at( 0 );
            y = v.at( 1 );
            z = v.at( 2 );
            return true;
        }
        return false;
    }

    bool optimize( zi::vl::vec< T, 3 >& v,
                          const zi::vl::vec< T, 3 >& v1,
                          const zi::vl::vec< T, 3 >& v2 ) const
    {
        zi::vl::vec< T, 3 > d = v1 - v2;
        zi::vl::mat< T, 3 > a = tensor();

        zi::vl::vec< T, 3 > av2 = a * v2;
        zi::vl::vec< T, 3 > ad  = a * d;

        const T denom = dot( d, ad );

        if ( std::fabs( denom ) <= std::numeric_limits< T >::epsilon() )
        {
            return false;
        }

        T invdenom = static_cast< T >( 2 ) / denom;

        T q = -( dot( vector(), d ) * 2 + dot( av2, d ) + dot( v2, ad ) ) * invdenom;

        q = q < 0 ? 0 : ( q > 1 ? 1 : q );

        v = q * d + v2;

        return true;
    }

    template< class CharT, class Traits >
    friend inline ::std::basic_ostream< CharT, Traits >&
    operator<< ( ::std::basic_ostream< CharT, Traits >& os, const quadratic< T >& q )
    {
        os << "/ "  << q.a2 << ' ' << q.ab << ' ' << q.ac << ' ' << q.ad << " \\\n"
           << "| "  << q.ab << ' ' << q.b2 << ' ' << q.bc << ' ' << q.bd << " |\n"
           << "| "  << q.ac << ' ' << q.bc << ' ' << q.c2 << ' ' << q.cd << " |\n"
           << "\\ " << q.ad << ' ' << q.bd << ' ' << q.cd << ' ' << q.d2 << " /\n";
        return os;
    }

};


template< class T, class Y >
inline
quadratic< typename ::zi::vl::detail::promote< T, Y >::type >
operator+( const quadratic< T >& x, const quadratic< Y >& y )
{
    quadratic< typename ::zi::vl::detail::promote< T, Y >::type > res( x );
    res += y;
    return res;
}

template< class T >
inline
quadratic< T >
operator+( const quadratic< T >& x, const quadratic< T >& y )
{
    quadratic< T > res( x );
    res += y;
    return res;
}

template< class T, class Y >
inline
quadratic< typename ::zi::vl::detail::promote< T, Y >::type >
operator-( const quadratic< T >& x, const quadratic< Y >& y )
{
    quadratic< typename ::zi::vl::detail::promote< T, Y >::type > res( x );
    res -= y;
    return res;
}

template< class T >
inline
quadratic< T >
operator-( const quadratic< T >& x, const quadratic< T >& y )
{
    quadratic< T > res( x );
    res -= y;
    return res;
}

template< class T >
inline quadratic< T >
operator+( const quadratic< T >& x, const T& y )
{
    quadratic< T > res( x );
    res += y;
    return res;
}

template< class T >
inline quadratic< T >
operator+( const T& y, const quadratic< T >& x )
{
    quadratic< T > res( x );
    res += y;
    return res;
}

template< class T >
inline quadratic< T >
operator-( const quadratic< T >& x, const T& y )
{
    quadratic< T > res( x );
    res -= y;
    return res;
}

template< class T >
inline quadratic< T >
operator*( const quadratic< T >& x, const T& y )
{
    quadratic< T > res( x );
    res *= y;
    return res;
}

template< class T >
inline quadratic< T >
operator*( const T& y, const quadratic< T >& x )
{
    quadratic< T > res( x );
    res *= y;
    return res;
}

} // namespace detail
} // namespace mesh
} // namespace zi

#endif

