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

#ifndef ZI_UTILITY_ASSERT_HPP
#define ZI_UTILITY_ASSERT_HPP 1
#
#include <zi/config/config.hpp>
#include <cassert>
#
#undef ZI_VERIFY
#
#if defined( NDEBUG ) || defined ( ZI_NO_DEBUG )
#
#  define ZI_ASSERT( what )   static_cast< void >( 0 )
#  define ZI_ASSERT_T( what ) static_cast< void >( 0 )
#  define ZI_ASSERT_0( what ) static_cast< void >( 0 )
#
#  define ZI_VERIFY( what )   ( static_cast< void >( what ) )
#  define ZI_VERIFY_T( what ) ( static_cast< void >( what ) )
#  define ZI_VERIFY_0( what ) ( static_cast< void >( what ) )
#
#  define ZI_DEBUG_BLOCK() if ( false )
#
#else
#
#  define ZI_ASSERT( what )   assert( what )
#  define ZI_ASSERT_T( what ) assert( what )
#  define ZI_ASSERT_0( what ) assert( !static_cast< bool >( what ) )
#
#  define ZI_VERIFY( what )   assert( what )
#  define ZI_VERIFY_T( what ) assert( what )
#  define ZI_VERIFY_0( what ) assert( !static_cast< bool >( what ) )
#
#  define ZI_DEBUG_BLOCK() if ( true )
#
#endif
#
#endif
