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

#ifndef ZI_VL_QUAT_HPP
#define ZI_VL_QUAT_HPP 1

#include <zi/vl/mat.hpp>
#include <zi/vl/vec.hpp>

namespace zi {
namespace vl {

namespace detail {

struct  quat_identity_tag   { explicit quat_identity_tag()   {} };

} // namespace detail


template< class T >
class quat
{
private:
    ZI_STATIC_ASSERT( is_floating_point< T >::value , non_floating_point_quat );

protected:
    T d[ 4 ];

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

    typedef quat< T >      type;

public:

    //
    // Constructors
    // ---------------------------------------------------------------------
    //

    explicit quat( const T& q0 = T(),
                   const T& q1 = T(),
                   const T& q2 = T(),
                   const T& q3 = T() )
    {
        d[ 0 ] = q0;
        d[ 1 ] = q1;
        d[ 2 ] = q2;
        d[ 3 ] = q3;
    }

    template< class O >
    explicit quat( const quat< O >& q )
    {
        d[ 0 ] = static_cast< T >( q.at( 0 ) );
        d[ 1 ] = static_cast< T >( q.at( 1 ) );
        d[ 2 ] = static_cast< T >( q.at( 2 ) );
        d[ 3 ] = static_cast< T >( q.at( 3 ) );
    }

    template< class O >
    explicit quat( const vec< O, 3 >& v, const T& q3 = T() )
    {
        d[ 0 ] = static_cast< T >( v.at( 0 ) );
        d[ 1 ] = static_cast< T >( v.at( 1 ) );
        d[ 2 ] = static_cast< T >( v.at( 2 ) );
        d[ 3 ] = q3;
    }

    explicit quat( const vec< T, 3 >& v, const T& q3 = T() )
    {
        d[ 0 ] = v.at( 0 );
        d[ 1 ] = v.at( 1 );
        d[ 2 ] = v.at( 2 );
        d[ 3 ] = q3;
    }

    template< class O >
    explicit quat( const vec< O, 4 >& v )
    {
        d[ 0 ] = static_cast< T >( v.at( 0 ) );
        d[ 1 ] = static_cast< T >( v.at( 1 ) );
        d[ 2 ] = static_cast< T >( v.at( 2 ) );
        d[ 3 ] = static_cast< T >( v.at( 3 ) );
    }

    explicit quat( const vec< T, 4 >& v )
    {
        d[ 0 ] = v.at( 0 );
        d[ 1 ] = v.at( 1 );
        d[ 2 ] = v.at( 2 );
        d[ 3 ] = v.at( 3 );
    }

    template< class O, std::size_t N >
    explicit quat( const mat< T, N >& m,
                   typename detail::enable_if_c< ( N > 2 ), O >::type* = 0 )
    {
        mat< T, 3 > mcopy( m.at( 0, 0 ), m.at( 0, 1 ), m.at( 0, 2 ),
                           m.at( 1, 0 ), m.at( 1, 1 ), m.at( 1, 2 ),
                           m.at( 2, 0 ), m.at( 2, 1 ), m.at( 2, 2 ) );
        set_rot_matrix( mcopy );
    }

    explicit quat( const detail::quat_identity_tag& )
    {
        d[ 0 ] = d[ 1 ] = d[ 2 ] = static_cast< T >( 0 );
        d[ 3 ] = 1;
    }


    //
    // Accessors
    // ---------------------------------------------------------------------
    //

public:

#define ZI_VL_INDEX_ACCESSOR_BODY( idx )        \
    ZI_ASSERT( ( idx < 4 ) && "out of range" ); \
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
    ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER( real, 3 );

#undef ZI_VL_INDEX_ACCESSOR_BODY
#undef ZI_VL_INDEX_ACCESSOR_MEMBER
#undef ZI_VL_NAMED_INDEX_ACCESSOR_MEMBER

    quat< T > unreal() const
    {
        return quat< T >( d[ 0 ], d[ 1 ], d[ 2 ], 0 );
    }

    vec< T, 3 > unreal_vec() const
    {
        return vec< T, 3 >( d[ 0 ], d[ 1 ], d[ 2 ] );
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


    template< std::size_t I >
    reference get()
    {
        ZI_STATIC_ASSERT( I < 4, index_out_of_range );
        return d[ I ];
    }

    template< std::size_t I >
    const_reference get() const
    {
        ZI_STATIC_ASSERT( I < 4, index_out_of_range );
        return d[ I ];
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
        return d + 4;
    }

    const_iterator end() const
    {
        return d + 4;
    }

    reverse_iterator rbegin()
    {
        return d + 4 - 1;
    }

    reverse_const_iterator rbegin() const
    {
        return d + 4 - 1;
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
        return d[ 4 - 1 ];
    }

    const_reference back() const
    {
        return d[ 4 - 1 ];
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
    quat< T >& operator=( const quat< O >& rhs )
    {
        d[ 0 ] = rhs.at( 0 );
        d[ 1 ] = rhs.at( 1 );
        d[ 2 ] = rhs.at( 2 );
        d[ 3 ] = rhs.at( 3 );
        return *this;
    }

    quat< T >& operator=( const quat< T >& rhs )
    {
        d[ 0 ] = rhs.at( 0 );
        d[ 1 ] = rhs.at( 1 );
        d[ 2 ] = rhs.at( 2 );
        d[ 3 ] = rhs.at( 3 );
        return *this;
    }

    quat< T >& operator=( const T& rhs )
    {
        d[ 0 ] = d[ 1 ] = d[ 2 ] = static_cast< T >( 0 );
        d[ 3 ] = rhs;
    }

    void fill( const T& val )
    {
        d[ 0 ] = d[ 1 ] = d[ 2 ] = d[ 3 ] = val;
    }

    void assign( const T& val )
    {
        d[ 0 ] = d[ 1 ] = d[ 2 ] = d[ 3 ] = val;
    }


    //
    // Compound Assignment Operators
    // ---------------------------------------------------------------------
    //

#define ZI_VL_COMPOUND_OPERATOR_SCALAR( op )    \
                                                \
    quat< T >& operator op ( const T& rhs )     \
    {                                           \
        d[ 0 ] op rhs;                          \
        d[ 1 ] op rhs;                          \
        d[ 2 ] op rhs;                          \
        d[ 3 ] op rhs;                          \
        return *this;                           \
    }

#define ZI_VL_COMPOUND_OPERATOR_TYPE( op )                      \
                                                                \
    template< class X >                                         \
    quat< T >& operator op ( const quat< X >& rhs )             \
    {                                                           \
        d[ 0 ] op rhs.at( 0 );                                  \
        d[ 1 ] op rhs.at( 1 );                                  \
        d[ 2 ] op rhs.at( 2 );                                  \
        d[ 3 ] op rhs.at( 3 );                                  \
        return *this;                                           \
    }                                                           \
                                                                \
        quat< T >& operator op ( const quat< T >& rhs )         \
    {                                                           \
        d[ 0 ] op rhs.at( 0 );                                  \
        d[ 1 ] op rhs.at( 1 );                                  \
        d[ 2 ] op rhs.at( 2 );                                  \
        d[ 3 ] op rhs.at( 3 );                                  \
        return *this;                                           \
    }                                                           \
                                                                \
    template< class X >                                         \
    quat< T >& operator op ( const vec< X, 3 >& rhs )           \
    {                                                           \
        d[ 0 ] op rhs.at( 0 );                                  \
        d[ 1 ] op rhs.at( 1 );                                  \
        d[ 2 ] op rhs.at( 2 );                                  \
        return *this;                                           \
    }                                                           \
                                                                \
        quat< T >& operator op ( const vec< T, 3 >& rhs )       \
    {                                                           \
        d[ 0 ] op rhs.at( 0 );                                  \
        d[ 1 ] op rhs.at( 1 );                                  \
        d[ 2 ] op rhs.at( 2 );                                  \
        return *this;                                           \
    }


    ZI_VL_COMPOUND_OPERATOR_TYPE( += )
    ZI_VL_COMPOUND_OPERATOR_TYPE( -= )

    ZI_VL_COMPOUND_OPERATOR_SCALAR( *= )

#undef ZI_VL_COMPOUND_OPERATOR_SCALAR
#undef ZI_VL_COMPOUND_OPERATOR_TYPE

    template< class O >
    quat< T >& operator*=( const vec< O, 3 >& rhs )
    {
        T xt = d[ 0 ];
        T yt = d[ 1 ];
        T zt = d[ 2 ];
        T wt = d[ 3 ];

        d[ 3 ] = -xt*rhs.at( 0 )-yt*rhs.at( 1 )-zt*rhs.at( 2 );
        d[ 0 ] = +wt*rhs.at( 0 )+yt*rhs.at( 2 )-zt*rhs.at( 1 );
        d[ 1 ] = +wt*rhs.at( 1 )-xt*rhs.at( 2 )+zt*rhs.at( 0 );
        d[ 2 ] = +wt*rhs.at( 2 )+xt*rhs.at( 1 )-yt*rhs.at( 0 );

        return *this;
    }

    quat< T >& operator*=( const vec< T, 3 >& rhs )
    {
        T xt = d[ 0 ];
        T yt = d[ 1 ];
        T zt = d[ 2 ];
        T wt = d[ 3 ];

        d[ 3 ] = -xt*rhs.at( 0 )-yt*rhs.at( 1 )-zt*rhs.at( 2 );
        d[ 0 ] = +wt*rhs.at( 0 )+yt*rhs.at( 2 )-zt*rhs.at( 1 );
        d[ 1 ] = +wt*rhs.at( 1 )-xt*rhs.at( 2 )+zt*rhs.at( 0 );
        d[ 2 ] = +wt*rhs.at( 2 )+xt*rhs.at( 1 )-yt*rhs.at( 0 );

        return *this;
    }

        // Henrik Engstrom, from a gamedev.net article.

#define ZI_VL_COMPOUND_MUL_OPERATOR_BODY                \
        const T& x0 = d[ 3 ];                           \
        const T& x1 = d[ 0 ];                           \
        const T& x2 = d[ 1 ];                           \
        const T& x3 = d[ 2 ];                           \
        const T& y0 = rhs.at( 3 );                      \
        const T& y1 = rhs.at( 0 );                      \
        const T& y2 = rhs.at( 1 );                      \
        const T& y3 = rhs.at( 2 );                      \
                                                        \
        const T tmp_00 = ( x3 - x2 ) * (y2 - y3);       \
        const T tmp_01 = ( x0 + x1 ) * (y0 + y1);       \
        const T tmp_02 = ( x0 - x1 ) * (y2 + y3);       \
        const T tmp_03 = ( x2 + x3 ) * (y0 - y1);       \
        const T tmp_04 = ( x3 - x1 ) * (y1 - y2);       \
        const T tmp_05 = ( x3 + x1 ) * (y1 + y2);       \
        const T tmp_06 = ( x0 + x2 ) * (y0 - y3);       \
        const T tmp_07 = ( x0 - x2 ) * (y0 + y3);       \
        const T tmp_08 = tmp_05 + tmp_06 + tmp_07;      \
        const T tmp_09 = 0.5 * (tmp_04 + tmp_08);       \
                                                        \
        d[ 3 ] = tmp_00 + tmp_09 - tmp_05;              \
        d[ 0 ] = tmp_01 + tmp_09 - tmp_08;              \
        d[ 1 ] = tmp_02 + tmp_09 - tmp_07;              \
        d[ 2 ] = tmp_03 + tmp_09 - tmp_06;              \
                                                        \
        return *this


    template< class O >
    quat< T >& operator*=( const quat< O >& rhs )
    {
        ZI_VL_COMPOUND_MUL_OPERATOR_BODY;
    }

    quat< T >& operator*=( const quat< T >& rhs )
    {
        ZI_VL_COMPOUND_MUL_OPERATOR_BODY;
    }

#undef ZI_VL_COMPOUND_MUL_OPERATOR_BODY

    quat< T >& operator/=( const T& rhs )
    {
        T invc = static_cast< T >( 1 ) / rhs;
        d[ 0 ] *= invc;
        d[ 1 ] *= invc;
        d[ 2 ] *= invc;
        d[ 3 ] *= invc;
        return *this;
    }

    quat< T >& operator+=( const T& rhs )
    {
        d[ 3 ] += rhs;
        return *this;
    }

    quat< T >& operator-=( const T& rhs )
    {
        d[ 3 ] -= rhs;
        return *this;
    }

public:

    static size_type size()
    {
        return 4;
    }

    void swap( quat< T >& rhs )
    {
        ::std::swap( d[ 0 ], rhs.at( 0 ) );
        ::std::swap( d[ 1 ], rhs.at( 1 ) );
        ::std::swap( d[ 2 ], rhs.at( 2 ) );
        ::std::swap( d[ 3 ], rhs.at( 3 ) );
    }

    static void rangecheck( size_type i )
    {
        if ( i >= 4 )
        {
            throw std::out_of_range( "quat<>: index out of range" );
        }
    }

    void set_rot_matrix( const mat< T, 3 >& m )
    {
        static const T epsilon = std::sqrt( std::numeric_limits< T >::epsilon() );

        T trace =  m.at( 0, 0 ) + m.at( 1, 1 ) + m.at( 2, 2 ) + 1;

        if ( trace > epsilon )
        {
            T r = std::sqrt( trace );
            T s = static_cast< T >( 0.5 ) / r;

            d[ 0 ] = ( m.at( 2, 1 ) - m.at( 1, 2 ) ) * s;
            d[ 1 ] = ( m.at( 0, 2 ) - m.at( 2, 0 ) ) * s;
            d[ 2 ] = ( m.at( 1, 0 ) - m.at( 0, 1 ) ) * s;
            d[ 3 ] = r * 0.5;
        }
        else
        {
            vec< T, 3 > diag( m.at( 0, 0 ), m.at( 1, 1 ), m.at( 2, 2 ) );
            std::size_t idx = diag.max_index();

            if ( idx == 0 )
            {
                T r = std::sqrt( m.at( 0, 0 ) + 1.0 - m.at( 1, 1 ) - m.at( 2, 2 ));
                T s = static_cast< T >( 0.5 ) / r;

                d[ 0 ] = r * 0.5;
                d[ 1 ] = ( m.at( 0, 1 ) + m.at( 1, 0 ) ) * s;
                d[ 2 ] = ( m.at( 0, 2 ) + m.at( 2, 0 ) ) * s;
                d[ 3 ] = ( m.at( 1, 2 ) - m.at( 2, 1 ) ) * s;

            }
            else if ( idx == 1 )
            {
                T r = std::sqrt( m.at( 1, 1 ) + 1.0 - m.at( 0, 0 ) - m.at( 2, 2 ));
                T s = static_cast< T >( 0.5 ) / r;

                d[ 0 ] = ( m.at( 0, 1 ) + m.at( 1, 0 ) ) * s;
                d[ 1 ] = r * 0.5;
                d[ 2 ] = ( m.at( 1, 2 ) + m.at( 2, 1 ) ) * s;
                d[ 3 ] = ( m.at( 0, 2 ) - m.at( 2, 0 ) ) * s;
            }
            else if ( idx == 2 )
            {
                T r = std::sqrt( m.at( 2, 2 ) + 1.0 - m.at( 0, 0 ) - m.at( 1, 1 ));
                T s = static_cast< T >( 0.5 ) / r;

                d[ 0 ] = ( m.at( 0, 2 ) + m.at( 2, 0 ) ) * s;
                d[ 1 ] = ( m.at( 1, 2 ) + m.at( 2, 1 ) ) * s;
                d[ 2 ] = r * 0.5;
                d[ 3 ] = ( m.at( 0, 1 ) - m.at( 1, 0 ) ) * s;

            }
            else
            {
                throw ::std::runtime_error( "quat<>: no max on the matrix diagonal" );
            }

        }
    }

    static const quat< T > zero;
    static const quat< T > quater_i;
    static const quat< T > quater_j;
    static const quat< T > quater_k;
    static const quat< T > quat_i;
    static const quat< T > quat_j;
    static const quat< T > quat_k;
    static const quat< T > identity;
    static const quat< T > unit_i;
    static const quat< T > unit_j;
    static const quat< T > unit_k;
    static const quat< T > unit_w;
    static const quat< T > unit;

};


template< class T > const quat< T > quat< T >::zero    ( 0, 0, 0, 0 );
template< class T > const quat< T > quat< T >::quater_i( 1, 0, 0, 0 );
template< class T > const quat< T > quat< T >::quater_j( 0, 1, 0, 0 );
template< class T > const quat< T > quat< T >::quater_k( 0, 0, 1, 0 );
template< class T > const quat< T > quat< T >::quat_i  ( 1, 0, 0, 0 );
template< class T > const quat< T > quat< T >::quat_j  ( 0, 1, 0, 0 );
template< class T > const quat< T > quat< T >::quat_k  ( 0, 0, 1, 0 );
template< class T > const quat< T > quat< T >::identity( 0, 0, 0, 1 );
template< class T > const quat< T > quat< T >::unit_i  ( 1, 0, 0, 0 );
template< class T > const quat< T > quat< T >::unit_j  ( 0, 1, 0, 0 );
template< class T > const quat< T > quat< T >::unit_k  ( 0, 0, 1, 0 );
template< class T > const quat< T > quat< T >::unit_w  ( 0, 0, 0, 1 );
template< class T > const quat< T > quat< T >::unit    ( 0, 0, 0, 1 );

typedef quat< float       > quatf;
typedef quat< double      > quatd;
typedef quat< long double > quatld;

//
// Comparison
// ---------------------------------------------------------------------
//

template< class T, class O >
inline bool operator==( const quat< T >& lhs,
                        const quat< O >& rhs )
{
    return std::equal( lhs.begin(), lhs.end(), rhs.begin() );
}

template< class T >
inline bool operator==( const quat< T >& lhs,
                        const quat< T >& rhs )
{
    return std::equal( lhs.begin(), lhs.end(), rhs.begin() );
}

template< class T, class O >
inline bool operator==( const quat< T >& lhs,
                        const vec< O, 3 >& rhs )
{
    return lhs.at( 3 ) == 0
        && std::equal( rhs.begin(), rhs.end(), lhs.begin() );
}

template< class T >
inline bool operator==( const quat< T >& lhs,
                        const vec< T, 3 >& rhs )
{
    return lhs.at( 3 ) == 0
        && std::equal( rhs.begin(), rhs.end(), lhs.begin() );
}

template< class T, class O >
inline bool operator==( const vec< T, 3 >& lhs,
                        const quat< O >& rhs )
{
    return rhs.at( 3 ) == 0
        && std::equal( lhs.begin(), lhs.end(), rhs.begin() );
}

template< class T >
inline bool operator==( const vec< T, 3 >& lhs,
                        const quat< T >& rhs )
{
    return rhs.at( 3 ) == 0
        && std::equal( lhs.begin(), lhs.end(), rhs.begin() );
}

template< class T >
inline bool operator==( const T& lhs,
                        const quat< T >& rhs )
{
    return
        rhs.at( 3 ) == lhs &&
        rhs.at( 0 ) == 0 &&
        rhs.at( 1 ) == 0 &&
        rhs.at( 2 ) == 0;
}

template< class T >
inline bool operator==( const quat< T >& lhs,
                        const T& rhs )
{
    return
        lhs.at( 3 ) == rhs &&
        lhs.at( 0 ) == 0 &&
        lhs.at( 1 ) == 0 &&
        lhs.at( 2 ) == 0;
}

template< class T, class O >
inline bool operator!=( const quat< T >& lhs,
                        const quat< O >& rhs )
{
    return !( lhs == rhs );
}

template< class T >
inline bool operator!=( const quat< T >& lhs,
                        const quat< T >& rhs )
{
    return !( lhs == rhs );
}

template< class T, class O >
inline bool operator!=( const vec< T, 3 >& lhs,
                        const quat< O >& rhs )
{
    return !( lhs == rhs );
}

template< class T >
inline bool operator!=( const vec< T, 3 >& lhs,
                        const quat< T >& rhs )
{
    return !( lhs == rhs );
}

template< class T, class O >
inline bool operator!=( const quat< T >& lhs,
                        const vec< O, 3 >& rhs )
{
    return !( lhs == rhs );
}

template< class T >
inline bool operator!=( const quat< T >& lhs,
                        const vec< T, 3 >& rhs )
{
    return !( lhs == rhs );
}

template< class T >
inline bool operator!=( const quat< T >& lhs,
                        const T& rhs )
{
    return !( lhs == rhs );
}

template< class T >
inline bool operator!=( const T& lhs,
                        const quat< T >& rhs )
{
    return !( lhs == rhs );
}

template< class T, class O >
inline bool operator<( const quat< T >& lhs,
                       const quat< O >& rhs )
{
    return std::lexicographical_compare( lhs.begin(), lhs.end(),
                                         rhs.begin(), rhs.end() );
}

template< class T >
inline bool operator<( const quat< T >& lhs,
                       const quat< T >& rhs )
{
    return std::lexicographical_compare( lhs.begin(), lhs.end(),
                                         rhs.begin(), rhs.end() );
}

template< class T, class O >
inline bool operator>( const quat< T >& lhs,
                       const quat< O >& rhs )
{
    return ( rhs < lhs );
}

template< class T >
inline bool operator>( const quat< T >& lhs,
                       const quat< T >& rhs )
{
    return ( rhs < lhs );
}

template< class T, class O >
inline bool operator<=( const quat< T >& lhs,
                        const quat< O >& rhs )
{
    return !( rhs < lhs );
}

template< class T >
inline bool operator<=( const quat< T >& lhs,
                        const quat< T >& rhs )
{
    return !( rhs < lhs );
}

template< class T, class O >
inline bool operator>=( const quat< T >& lhs,
                        const quat< O >& rhs )
{
    return !( lhs < rhs );
}

template< class T >
inline bool operator>=( const quat< T >& lhs,
                        const quat< T >& rhs )
{
    return !( lhs < rhs );
}

//
// Basic arithmetic
// ---------------------------------------------------------------------
//

#define ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE( op )          \
                                                                \
    template< class T >                                         \
    inline                                                      \
    typename quat< T >::type                                    \
    operator op( const T& lhs, const quat< T >& rhs )           \
    {                                                           \
        quat< T >res( rhs );                                    \
        res op##= lhs;                                          \
        return res;                                             \
    }                                                           \
                                                                \
    template< class T, class O >                                \
    inline                                                      \
    typename detail::enable_if                                  \
    < is_scalar< T >,                                           \
      quat< typename detail::promote< O, T >::type > >::type    \
    operator op( const T& lhs, const quat< O >& rhs )           \
      {                                                         \
          quat< typename detail::promote< O, T >::type >        \
              res( rhs );                                       \
          res op##= lhs;                                        \
          return res;                                           \
      }


#define ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( op )                  \
                                                                        \
    template< class O, class T >                                        \
    inline                                                              \
    typename detail::enable_if                                          \
    < is_scalar< O >,                                                   \
      quat< typename detail::promote< O, T >::type > >::type            \
    operator op( const quat< T >& lhs, const O& rhs )                   \
      {                                                                 \
          quat< typename detail::promote< O, T >::type > res( lhs );    \
          res op##= rhs;                                                \
          return res;                                                   \
      }                                                                 \
                                                                        \
    template< class T >                                                 \
    inline                                                              \
    quat< T >                                                           \
    operator op( const quat< T >& lhs, const T& rhs )                   \
    {                                                                   \
        quat< T > res( lhs );                                           \
        res op##= rhs;                                                  \
        return res;                                                     \
    }

#define ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE( op )                    \
    template< class T, class O >                                        \
    inline                                                              \
    quat< typename detail::promote< O, T >::type >                      \
    operator op( const quat< T >& lhs, const quat< O >& rhs )           \
    {                                                                   \
        quat< typename detail::promote< O, T >::type > res( lhs );      \
        res op##= rhs;                                                  \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T >                                                 \
    inline                                                              \
    typename quat< T >::type                                            \
    operator op( const quat< T >& lhs, const quat< T >& rhs )           \
    {                                                                   \
        quat< T > res( lhs );                                           \
        res op##= rhs;                                                  \
        return res;                                                     \
    }

#define ZI_VL_INLINE_BINARY_OPERATOR_TYPE_VEC3( op )                    \
    template< class T, class O >                                        \
    inline                                                              \
    quat< typename detail::promote< O, T >::type >                      \
    operator op( const quat< T >& lhs, const vec< O, 3 >& rhs )         \
    {                                                                   \
        quat< typename detail::promote< O, T >::type > res( lhs );      \
        res op##= rhs;                                                  \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T >                                                 \
    inline                                                              \
    typename quat< T >::type                                            \
    operator op( const quat< T >& lhs, const vec< T, 3 >& rhs )         \
    {                                                                   \
        quat< T > res( lhs );                                           \
        res op##= rhs;                                                  \
        return res;                                                     \
    }


#define ZI_VL_INLINE_BINARY_OPERATOR( op )              \
    ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( op )      \
    ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE( op )      \
    ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE( op )        \
    ZI_VL_INLINE_BINARY_OPERATOR_TYPE_VEC3( op )


ZI_VL_INLINE_BINARY_OPERATOR( + )
ZI_VL_INLINE_BINARY_OPERATOR( - )
ZI_VL_INLINE_BINARY_OPERATOR( * )

ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR( / )
ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE( / )

#undef ZI_VL_INLINE_BINARY_OPERATOR
#undef ZI_VL_INLINE_BINARY_OPERATOR_TYPE_TYPE
#undef ZI_VL_INLINE_BINARY_OPERATOR_TYPE_VEC3
#undef ZI_VL_INLINE_BINARY_OPERATOR_SCALAR_TYPE
#undef ZI_VL_INLINE_BINARY_OPERATOR_TYPE_SCALAR


template< class T >
inline
quat< T > operator+( const quat< T >& rhs )
{
    return rhs;
}

template< class T >
inline
quat< T > operator-( const quat< T >& rhs )
{
    return quat< T >( -rhs.at( 0 ), -rhs.at( 1 ), -rhs.at( 2 ), -rhs.at( 3 ) );
}

template< class T, class CharT, class Traits >
::std::basic_ostream< CharT, Traits >&
operator<<( ::std::basic_ostream< CharT, Traits >& os,
            const quat< T >& q )
{
    return os << "( " << q[ 0 ] << ", " << q[ 1 ] << ", "
              << q[ 2 ] << " | " << q[ 3 ] << " )";
}

template< std::size_t I, class T >
inline const T& get( const quat< T >& q )
{
    return q.template get< I >();
}

template< std::size_t I, class T >
inline T& get( quat< T >& q )
{
    return q.template get< I >();
}


} // namespace vl
} // namespace zi

// provide functionality

#include <zi/vl/quat_functions.hpp>

#endif
