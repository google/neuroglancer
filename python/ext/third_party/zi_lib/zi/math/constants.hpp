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

#ifndef ZI_MATH_CONSTANTS_HPP
#define ZI_MATH_CONSTANTS_HPP 1

#include <zi/zpp/stringify.hpp>
#include <zi/zpp/glue.hpp>
#include <zi/debug/printable_type.hpp>

#include <string>
#include <sstream>
#include <stdexcept>

namespace zi {
namespace math {

namespace constants_impl {

#define ZI_MATH_CONSTANT_DEFINITION( name, value, more, exp )   \
                                                                \
    template< class T > inline T                                \
    name()                                                      \
    {                                                           \
        std::stringstream ss;                                   \
        ss << ZiPP_STRINGIFY( ZiPP_GLUE                         \
                              ( ZiPP_GLUE( value, more ),       \
                                ZiPP_GLUE( e, exp )));          \
        T res;                                                  \
        if ( ss >> res )                                        \
        {                                                       \
            if ( ss.eof() )                                     \
            {                                                   \
                return res;                                     \
            }                                                   \
        }                                                       \
                                                                \
        throw std::logic_error                                  \
            ( std::string( "zi::math::constant<>::" ) +         \
              ZiPP_STRINGIFY( name ) +                          \
              "() not defined for the type " +                  \
              ::zi::debug::printable_type< T >() );             \
                                                                \
    }                                                           \
                                                                \
    template<> inline float                                     \
    name< float >()                                             \
    {                                                           \
        return ZiPP_GLUE( ZiPP_GLUE                             \
                          ( ZiPP_GLUE( value, e ), exp ), F );  \
    }                                                           \
                                                                \
    template<> inline double                                    \
    name< double >()                                            \
    {                                                           \
        return ZiPP_GLUE( ZiPP_GLUE( value, e ), exp );         \
    }                                                           \
                                                                \
    template<> inline long double                               \
    name< long double >()                                       \
    {                                                           \
        return ZiPP_GLUE( ZiPP_GLUE                             \
                          ( ZiPP_GLUE( value, e ), exp ), L );  \
    }

ZI_MATH_CONSTANT_DEFINITION( pi,               3.141592653589793238462643383279502884197169399375105820974944,  59230781640628620899862803482534211706798214808651328230664709384460955058223172535940812848111745028410270193852110555964462294895493038196, 0 )
ZI_MATH_CONSTANT_DEFINITION( half_pi,          1.5707963267948966192313216916397514420985846996875529104874, 722961539082031431044993140174126710585339910740432566411533235469223047752911158626797040642405587251420513509692605527798223114744774651909822144054878329667230642378241168933915, 0 )
ZI_MATH_CONSTANT_DEFINITION( quarter_pi,       0.7853981633974483096156608458198757210492923498437764552437, 361480769541015715522496570087063355292669955370216283205766617734611523876455579313398520321202793625710256754846302763899111557372387325954911072027439164833615321189120584466957, 0 )
ZI_MATH_CONSTANT_DEFINITION( root_pi,          1.7724538509055160272981674833411451827975, 0, 0 )
ZI_MATH_CONSTANT_DEFINITION( root_half_pi,     1.253314137315500251207882642405522626503, 0, 0 )
ZI_MATH_CONSTANT_DEFINITION( root_two_pi,      2.506628274631000502415765284811045253007, 0, 0 )

ZI_MATH_CONSTANT_DEFINITION( e,                2.7182818284590452353602874713526624977572470936999595749669676, 27724076630353547594571382178525166427427466391932003059921817413596629043572900334295260595630738132328627943490763233829880753195251019011, 0 )
ZI_MATH_CONSTANT_DEFINITION( euler,            0.577215664901532860606512090082402431042159335939923598805, 76723488486, 0 )

ZI_MATH_CONSTANT_DEFINITION( root_two,         1.414213562373095048801688724209698078569671875376948073, 17667973799073247846210703885038753432764157273501384623091229702492483605585073721264412149709993583141322266592750559275579995050115278206, 0 )
ZI_MATH_CONSTANT_DEFINITION( half_root_two,    0.7071067811865475244008443621048490392848359376884740365883, 398689953662392310535194251937671638207863675069231154561485124624180279253686063220607485499679157066113329637527963778999752505763910302857350547799858029851372672984310073642587, 0 )


ZI_MATH_CONSTANT_DEFINITION( root_three,       1.7320508075688772935274463415058723669428052538103806280558, 069794519330169088000370811461867572485756756261414154067030299699450949989524788116555120943736485280932319023055820679748201010846749232650153123432669033228866506722546689218379, 0 )


ZI_MATH_CONSTANT_DEFINITION( ln_two,           0.693147180559945309417232121458176568075500134360255254, 120680009493393621969694715605863326996418687, 0 )
ZI_MATH_CONSTANT_DEFINITION( one_over_ln_two,  1.4426950408889634073599246810018921374266459541529859341354, 494069311092191811850798855266228935063444969975183096525442555931016871683596427206621582234793362745373698847184936307013876635320155338943189166648376431286154240474784222894979, 0 )
ZI_MATH_CONSTANT_DEFINITION( ln_ten,           2.3025850929940456840179914546843642076011014886287729760333, 279009675726096773524802359972050895982983419677840422862486334095254650828067566662873690987816894829072083255546808437998948262331985283935053089653777326288461633662222876982198, 0 )


ZI_MATH_CONSTANT_DEFINITION( half,             0.5, 0, 0 )
ZI_MATH_CONSTANT_DEFINITION( third,            0.3333333333333333333333333333333333333333333333333333333333333333333333, 3333333333333333333333333333333333333333333333333333333333333333333333333, 0 )
ZI_MATH_CONSTANT_DEFINITION( twothirds,        0.66666666666666666666666666666666666666666666666666666666666666666666, 66666666666666666666666666666666666666666666666666666666666666666666667, 0 )

#undef ZI_MATH_CONSTANT_DEFINITION


} // namespace constants_impl

template< class T >
struct constants
{
#define ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( name )       \
    static inline T name()                                      \
    {                                                           \
        return ::zi::math::constants_impl::name< T >();         \
    }

    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( pi )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( half_pi )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( quarter_pi )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( root_pi )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( root_half_pi )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( root_two_pi )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( e )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( euler )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( root_two )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( half_root_two )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( root_three )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( ln_two )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( one_over_ln_two )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( ln_ten )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( half )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( third )
    ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION( twothirds )

#undef ZI_MATH_CONSTANT_STATIC_MEMBER_DEFINITION

};

} // namespace math
} // namespace zi

#endif
