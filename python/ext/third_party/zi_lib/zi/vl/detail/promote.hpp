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

#ifndef ZI_VL_DETAIL_PROMOTE_HPP
#define ZI_VL_DETAIL_PROMOTE_HPP 1

#include <zi/bits/type_traits.hpp>
#include <zi/bits/cstdint.hpp>
#include <zi/meta/or.hpp>
#include <zi/meta/and.hpp>
#include <zi/meta/if.hpp>
#include <cstddef>

namespace zi {
namespace vl {

namespace detail {

template< class T >
struct promote_one
{
    typedef typename zi::meta::if_<
        is_integral< T >
        , double
        , T
        >::type type;
};

template<> struct promote_one< short       > { typedef double type; };
template<> struct promote_one< int         > { typedef double type; };
template<> struct promote_one< long        > { typedef double type; };
template<> struct promote_one< long long   > { typedef double type; };
template<> struct promote_one< float       > { typedef float type; };
template<> struct promote_one< double      > { typedef double type; };
template<> struct promote_one< long double > { typedef long double type; };

template< class X, class Y >
struct promote_two
{
    typedef typename promote_one< X >::type type1;
    typedef typename promote_one< Y >::type type2;

    typedef typename zi::meta::if_<
        typename zi::meta::and_<
            is_floating_point< type1 >
            , is_floating_point< type2 >
            >::type
        , typename zi::meta::if_<
              typename zi::meta::or_<
                  is_same< type1, long double >
                  , is_same< type2, long double >
                  >::type
              , long double
              , typename zi::meta::if_<
                    typename zi::meta::or_<
                        is_same< type1, double >
                        , is_same< type2, double >
                        >::type
                    , double
                    , float
                    >::type
              >::type
        , typename zi::meta::if_<
              is_convertible< type1, type2 >
              , type2
              , type1
              >::type
        >::type type;
};


template<> struct promote_two< short, short       > { typedef double type; };
template<> struct promote_two< short, int         > { typedef double type; };
template<> struct promote_two< short, long        > { typedef double type; };
template<> struct promote_two< short, long long   > { typedef double type; };
template<> struct promote_two< short, float       > { typedef double type; };
template<> struct promote_two< short, double      > { typedef double type; };
template<> struct promote_two< short, long double > { typedef long double type; };

template<> struct promote_two< int, short       > { typedef double type; };
template<> struct promote_two< int, int         > { typedef double type; };
template<> struct promote_two< int, long        > { typedef double type; };
template<> struct promote_two< int, long long   > { typedef double type; };
template<> struct promote_two< int, float       > { typedef double type; };
template<> struct promote_two< int, double      > { typedef double type; };
template<> struct promote_two< int, long double > { typedef long double type; };

template<> struct promote_two< long, short       > { typedef double type; };
template<> struct promote_two< long, int         > { typedef double type; };
template<> struct promote_two< long, long        > { typedef double type; };
template<> struct promote_two< long, long long   > { typedef double type; };
template<> struct promote_two< long, float       > { typedef double type; };
template<> struct promote_two< long, double      > { typedef double type; };
template<> struct promote_two< long, long double > { typedef long double type; };

template<> struct promote_two< long long, short       > { typedef double type; };
template<> struct promote_two< long long, int         > { typedef double type; };
template<> struct promote_two< long long, long        > { typedef double type; };
template<> struct promote_two< long long, long long   > { typedef double type; };
template<> struct promote_two< long long, float       > { typedef double type; };
template<> struct promote_two< long long, double      > { typedef double type; };
template<> struct promote_two< long long, long double > { typedef long double type; };

template<> struct promote_two< float, short       > { typedef double type; };
template<> struct promote_two< float, int         > { typedef double type; };
template<> struct promote_two< float, long        > { typedef double type; };
template<> struct promote_two< float, long long   > { typedef double type; };
template<> struct promote_two< float, float       > { typedef float  type; };
template<> struct promote_two< float, double      > { typedef double type; };
template<> struct promote_two< float, long double > { typedef long double type; };

template<> struct promote_two< double, short       > { typedef double type; };
template<> struct promote_two< double, int         > { typedef double type; };
template<> struct promote_two< double, long        > { typedef double type; };
template<> struct promote_two< double, long long   > { typedef double type; };
template<> struct promote_two< double, float       > { typedef double type; };
template<> struct promote_two< double, double      > { typedef double type; };
template<> struct promote_two< double, long double > { typedef long double type; };

template<> struct promote_two< long double, short       > { typedef long double type; };
template<> struct promote_two< long double, int         > { typedef long double type; };
template<> struct promote_two< long double, long        > { typedef long double type; };
template<> struct promote_two< long double, long long   > { typedef long double type; };
template<> struct promote_two< long double, float       > { typedef long double type; };
template<> struct promote_two< long double, double      > { typedef long double type; };
template<> struct promote_two< long double, long double > { typedef long double type; };

template< class T1,
          class T2 = float, class T3 = float,
          class T4 = float, class T5 = float,
          class T6 = float, class T7 = float,
          class T8 = float >
struct promote
{
    typedef typename promote_two<
        typename remove_cv< T1 >::type,
        typename promote_two<
            typename remove_cv< T2 >::type,
            typename promote_two<
                typename remove_cv< T3 >::type,
                typename promote_two<
                    typename remove_cv< T4 >::type,
                    typename promote_two<
                        typename remove_cv< T5 >::type,
                        typename promote_two<
                            typename remove_cv< T6 >::type,
                            typename promote_two<
                                typename remove_cv< T7 >::type,
                                typename remove_cv< T8 >::type
                                >::type
                            >::type
                        >::type
                    >::type
                >::type
            >::type
        >::type type;
};

} // namespace detail

} // namespace vl
} // namespace zi

#endif

