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

#ifndef ZI_ZPP_COUNT_ARGS_HPP
#define ZI_ZPP_COUNT_ARGS_HPP 1

#define ZiPP_COUNT_ARGS_Z( x, ... ) x
#define ZiPP_COUNT_ARGS_Y( x, ... ) ZiPP_COUNT_ARGS_Z( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_X( x, ... ) ZiPP_COUNT_ARGS_Y( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_W( x, ... ) ZiPP_COUNT_ARGS_X( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_V( x, ... ) ZiPP_COUNT_ARGS_W( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_U( x, ... ) ZiPP_COUNT_ARGS_V( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_T( x, ... ) ZiPP_COUNT_ARGS_U( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_S( x, ... ) ZiPP_COUNT_ARGS_T( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_R( x, ... ) ZiPP_COUNT_ARGS_S( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_Q( x, ... ) ZiPP_COUNT_ARGS_R( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_P( x, ... ) ZiPP_COUNT_ARGS_Q( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_O( x, ... ) ZiPP_COUNT_ARGS_P( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_N( x, ... ) ZiPP_COUNT_ARGS_O( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_M( x, ... ) ZiPP_COUNT_ARGS_N( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_L( x, ... ) ZiPP_COUNT_ARGS_M( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_K( x, ... ) ZiPP_COUNT_ARGS_L( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_J( x, ... ) ZiPP_COUNT_ARGS_K( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_I( x, ... ) ZiPP_COUNT_ARGS_J( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_H( x, ... ) ZiPP_COUNT_ARGS_I( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_G( x, ... ) ZiPP_COUNT_ARGS_H( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_F( x, ... ) ZiPP_COUNT_ARGS_G( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_E( x, ... ) ZiPP_COUNT_ARGS_F( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_D( x, ... ) ZiPP_COUNT_ARGS_E( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_C( x, ... ) ZiPP_COUNT_ARGS_D( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_B( x, ... ) ZiPP_COUNT_ARGS_C( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_A( x, ... ) ZiPP_COUNT_ARGS_B( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_9( x, ... ) ZiPP_COUNT_ARGS_A( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_8( x, ... ) ZiPP_COUNT_ARGS_9( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_7( x, ... ) ZiPP_COUNT_ARGS_8( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_6( x, ... ) ZiPP_COUNT_ARGS_7( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_5( x, ... ) ZiPP_COUNT_ARGS_6( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_4( x, ... ) ZiPP_COUNT_ARGS_5( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_3( x, ... ) ZiPP_COUNT_ARGS_4( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_2( x, ... ) ZiPP_COUNT_ARGS_3( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_1( x, ... ) ZiPP_COUNT_ARGS_2( __VA_ARGS__ )
#define ZiPP_COUNT_ARGS_0( x, ... ) ZiPP_COUNT_ARGS_1( __VA_ARGS__ )

#define ZiPP_COUNT_ARGS_HLP( ... )                              \
    ZiPP_COUNT_ARGS_0( ~, ##__VA_ARGS__,                        \
                       34, 33, 32, 31, 30,                      \
                       29, 28, 27, 26, 25, 24, 23, 22, 21, 20,  \
                       19, 18, 17, 16, 15, 14, 13, 12, 11, 10,  \
                       9, 8, 7, 6, 5, 4, 3, 2, 1, 0 )

#define ZiPP_COUNT_ARGS( ... ) ZiPP_COUNT_ARGS_HLP( __VA_ARGS__ )

#endif
