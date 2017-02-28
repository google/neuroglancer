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

#ifndef ZI_MESH_DETAIL_QMETRIC_HPP
#define ZI_MESH_DETAIL_QMETRIC_HPP 1

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

template< class T, std::size_t N >
class qmetric
{
private:
    ZI_STATIC_ASSERT( is_floating_point< T >::value , non_floating_point_qmetric );

protected:

    vl::mat< T, N >   tensor_;
    vl::vec< T, N >   vector_;
    T                 offset_;

public:
    inline T offset() const
    {
        return offset_;
    }

    const zi::vl::vec< T, N >& vector() const
    {
        return vector_;
    }

    const zi::vl::mat< T, N >& tensor() const
    {
        return tensor_;
    }

public:

    explicit qmetric( const T &off = T() )
        : tensor_(),
          vector_(),
          offset_( off )
    {
        tensor_.fill( 0 );
        vector_.fill( 0 );
    }

    explicit qmetric( const vl::vec< T, N >& p1,
                      const vl::vec< T, N >& p2,
                      const vl::vec< T, N >& p3 )
        : tensor_(),
          vector_(),
          offset_()
    {
        vl::vec< T, N > e1 = norm( p2 - p1 );
        vl::vec< T, N > e2 = p3 - p1;
        e2 = norm( e2 - e1 * dot( e1, e2 ) );

        tensor_ = vl::mat< T, N >::eye;
        tensor_ -= vl::oprod( e1, e1 );
        tensor_ -= vl::oprod( e2, e2 );

        T l1 = dot( p1, e1 );
        T l2 = dot( p1, e2 );

        vector_ = e1 * l1 + e2 * l2 - p1;

        offset_ = dot( p1, p1 ) - ( l1 * l1 ) - ( l2 * l2 );

    }

    template< class O >
    explicit qmetric( const qmetric< O, N >& o )
        : tensor_( o.tensor() ),
          vector_( o.vector() ),
          offset_( o.offset() )
    {
    }

    template< class X, class Y >
    explicit qmetric( const vl::mat< X, N >& t,
                      const vl::vec< Y, N >& v,
                      const T& o )
        : tensor_( t ),
          vector_( v ),
          offset_( o )
    {
    }

    explicit qmetric( const vl::mat< T, N >& t,
                      const vl::vec< T, N >& v,
                      const T& o )
        : tensor_( t ),
          vector_( v ),
          offset_( o )
    {
    }


    void clear()
    {
        tensor_.fill( 0 );
        vector_.fill( 0 );
        offset_ = 0;
    }

    qmetric< T, N >& operator =( const qmetric< T, N >& x )
    {
        tensor_ = x.tensor();
        vector_ = x.vector();
        offset_ = x.offset();
        return *this;
    }



#define ZI_QMETRIC_COMPOUND_OPERATOR( op )                              \
                                                                        \
    template< class Y >                                                 \
    qmetric< T, N >& operator op( const qmetric< Y, N >& x )            \
    {                                                                   \
        tensor_ op x.tensor();                                          \
        vector_ op x.vector();                                          \
        offset_ op x.offset();                                          \
        return *this;                                                   \
    }                                                                   \
                                                                        \
        qmetric< T, N >& operator op( const qmetric< T, N >& x )        \
    {                                                                   \
        tensor_ op x.tensor();                                          \
        vector_ op x.vector();                                          \
        offset_ op x.offset();                                          \
        return *this;                                                   \
    }


    ZI_QMETRIC_COMPOUND_OPERATOR( -= )
    ZI_QMETRIC_COMPOUND_OPERATOR( += )

#undef ZI_QMETRIC_COMPOUND_OPERATOR

    //    template< class Y >
    //    qmetric< T, N >& operator *=( const qmetric< Y, N >& x )
    //{
        // +-----+---+
        // |     |   |
        // |  A  | b |
        // |     |   |
        // +-----+---+
        // |  b  | c |
        // +-----+---+

        // +-----+---+
        // |  ---+---+--> A*A
        // |     |   |
        // |     | --+--> A*b + b*c
        // +-----+---+
        // |     | c-+--> c*c
        // +-----+---+

        //A^T*A*B^T*B  = B^T*B*A^T*A =

        // ( A + b + c )*( A2 + b2 + c2 )
        // = ( A*A2 + A*c2 + A2*c ) +

/*        vl::vec< T, N > b = vector_;
          vector_ = ( tensor_ * x.vector() + vector_ * x.offset() +
          x.tensor() * vector_ + x.vector() * offset_ ) * 0.5;

          tensor_ *= x.tensor();
          tensor_ += oprod( b, x.vector() );
          tensor_ *= 0.5;

          offset_ *= x.offset() * 0.5;
          return *this;
          }
*/
/*    qmetric< T, N >& operator *=( const qmetric< T, N >& x )
      {
      vl::vec< T, N > b = vector_;
      vector_ = ( tensor_ * x.vector() + vector_ * x.offset() +
      x.tensor() * vector_ + x.vector() * offset_ ) * 0.5;

      tensor_ *= x.tensor();
      tensor_ += oprod( b, x.vector() );
      tensor_ *= 0.5;

      offset_ *= x.offset() * 0.5;
      return *this;    }

*/
    qmetric< T, N >& operator*=( const T& rhs )
    {
        tensor_ *= rhs;
        vector_ *= rhs;
        offset_ *= rhs;
        return *this;
    }

    T evaluate( const vl::vec< T, N >& v ) const
    {
        return
            dot( v, tensor_ * v ) +
            dot( v, vector_ ) * static_cast< T >( 2 ) +
            offset_;
    }

    inline T operator()( const vl::vec< T, N >& v ) const
    {
        return evaluate( v );
    }

    inline bool optimize( vl::vec< T, N >& v ) const
    {
        bool ok;
        vl::mat< T, N > ainv = inv( tensor_, ok );

        if ( ok )
        {
            v = -( ainv * vector_ );
            return true;
        }

        return false;
    }

/*    inline bool optimize( zi::vl::vec< T, 3 >& v,
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
      }*/

    template< class CharT, class Traits >
    friend inline ::std::basic_ostream< CharT, Traits >&
    operator<< ( ::std::basic_ostream< CharT, Traits >& os, const qmetric< T, N >& q )
    {
        return os << "A:\n" << q.tensor_
                  << "\nb:\n" << q.vector_
                  << "\nc: "  << q.offset_;
    }

};


template< class T, std::size_t N >
inline
typename zi::vl::detail::enable_if
< is_floating_point< T >,
  qmetric< T, N > >::type
operator*( const qmetric< T, N >& x, const T& y )
{
    qmetric< T, N > res( x );
    res *= y;
    return res;
}

template< class T, std::size_t N >
inline
typename zi::vl::detail::enable_if
< is_floating_point< T >,
  qmetric< T, N > >::type
operator*( const T& y, const qmetric< T, N >& x )
{
    qmetric< T, N > res( x );
    res *= y;
    return res;
}

template< class T, class O, std::size_t N >
inline
qmetric< typename zi::vl::detail::promote< T, O >::type, N >
operator+( const qmetric< T, N >& x, const qmetric< O, N >& y )
{
    typedef typename zi::vl::detail::promote< T, O >::type PT;
    qmetric< PT, N > res( x );
    res += y;
    return res;
}

template< class T, std::size_t N >
inline
qmetric< T, N >
operator+( const qmetric< T, N >& x, const qmetric< T, N >& y )
{
    qmetric< T, N > res( x );
    res += y;
    return res;
}

template< class T, class O, std::size_t N >
inline
qmetric< typename zi::vl::detail::promote< T, O >::type, N >
operator-( const qmetric< T, N >& x, const qmetric< O, N >& y )
{
    typedef typename zi::vl::detail::promote< T, O >::type PT;
    qmetric< PT, N > res( x );
    res += y;
    return res;
}

template< class T, std::size_t N >
inline
qmetric< T, N >
operator-( const qmetric< T, N >& x, const qmetric< T, N >& y )
{
    qmetric< T, N > res( x );
    res += y;
    return res;
}


template< class T, std::size_t N >
inline qmetric< T, N >
operator+( const qmetric< T, N >& x )
{
    return x;
}

template< class T, std::size_t N >
inline qmetric< T, N >
operator-( const qmetric< T, N >& x )
{
    return qmetric< T, N >( -x.tensor(), -x.vector(), -x.offset() );;
}


} // namespace detail

    using detail::qmetric;

} // namespace mesh
} // namespace zi

#endif

