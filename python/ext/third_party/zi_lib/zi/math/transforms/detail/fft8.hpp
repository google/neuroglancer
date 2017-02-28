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

#ifndef ZI_MATH_TRANSFORMS_DETAIL_FFT8_HPP
#define ZI_MATH_TRANSFORMS_DETAIL_FFT8_HPP 1

#include <zi/math/constants.hpp>
#include <complex>

namespace zi {
namespace math {
namespace detail {

#define ZI_MATH_DETAIL_FFT8_DEFINE_FN( name, one_or_four, four_or_one,  \
                                       three_or_six, six_or_three,      \
                                       inv_c1, inv_c2, inv_c3 )         \
                                                                        \
                                                                        \
    template< class T >                                                 \
    inline void fft8_##name( std::complex< T > *f )                     \
    {                                                                   \
        std::complex< T > t1 = f[0] + f[one_or_four];                   \
        std::complex< T > m3 = f[0] - f[one_or_four];                   \
                                                                        \
        std::complex< T > t4 = f[four_or_one] + f[5];                   \
        std::complex< T > t3 = f[four_or_one] - f[5];                   \
                                                                        \
        std::complex< T > t5 = f[six_or_three] + f[7];                  \
        std::complex< T > t6 = f[six_or_three] - f[7];                  \
                                                                        \
        std::complex< T > t2 = f[2] + f[three_or_six];                  \
        std::complex< T > t7 = t1 + t2;                                 \
        std::complex< T > m2 = t1 - t2;                                 \
        std::complex< T > t8 = t4 + t5;                                 \
                                                                        \
        f[0] = t7 + t8;                                                 \
        f[four_or_one] = t7 - t8;                                       \
        std::complex< T > m4 =                                          \
            constants< T >::half_root_two() * ( t3 - t6 );              \
                                                                        \
        std::complex< T > m7 = std::complex< T >( 0, inv_c1 ) *         \
            ( t3 + t6 );                                                \
                                                                        \
        std::complex< T > m5 = ( inv_c2 ) * std::complex< T >( 0, 1 );  \
        std::complex< T > m6 = ( inv_c3 ) * std::complex< T >( 0, 1 );  \
                                                                        \
        t1 = m3 + m4;                                                   \
        t2 = m3 - m4;                                                   \
                                                                        \
        t3 = m6 + m7;                                                   \
        t4 = m6 - m7;                                                   \
                                                                        \
        f[7] = t1 + t3;                                                 \
        f[one_or_four] = t1 - t3;                                       \
                                                                        \
        f[three_or_six] = t2 + t4;                                      \
        f[5] = t2 - t4;                                                 \
                                                                        \
        f[six_or_three] = m2 + m5;                                      \
        f[2] = m2 - m5;                                                 \
    }


ZI_MATH_DETAIL_FFT8_DEFINE_FN( dit_forward, 1, 4, 3, 6,
                               -constants< T >::half_root_two(),
                               t5 - t4,
                               f[3] - f[2] )

ZI_MATH_DETAIL_FFT8_DEFINE_FN( dit_inverse, 1, 4, 3, 6,
                               constants< T >::half_root_two(),
                               t4 - t5,
                               f[2] - f[3] )

ZI_MATH_DETAIL_FFT8_DEFINE_FN( dif_forward, 4, 1, 6, 3,
                               -constants< T >::half_root_two(),
                               t5 - t4,
                               f[6] - f[2] )

ZI_MATH_DETAIL_FFT8_DEFINE_FN( dif_inverse, 4, 1, 6, 3,
                               constants< T >::half_root_two(),
                               t4 - t5,
                               f[2] - f[6] )


#undef ZI_MATH_DETAIL_FFT8_DEFINE_FN

} // namespace detail
} // namespace math
} // namespace zi

#endif

