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

#ifndef ZI_CONCURRENCY_PTHREAD_MUTEX_INITIALIZERS_HPP
#define ZI_CONCURRENCY_PTHREAD_MUTEX_INITIALIZERS_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/pthread/mutex_tags.hpp>

#include <zi/utility/assert.hpp>

#include <pthread.h>

namespace zi {
namespace concurrency_ {


template< class PtMutexTag > struct mutex_initializer;

template<> struct mutex_initializer< mutex_default_tag >
{
    static void initialize( pthread_mutex_t &ptm)
    {
#if defined( __USE_GNU )
        static const pthread_mutex_t stored_initializer =
            PTHREAD_MUTEX_INITIALIZER;
        ptm = stored_initializer;
#else
        ZI_VERIFY_0( pthread_mutex_init( &ptm, NULL ) );
#endif
    }

};

template<> struct mutex_initializer< mutex_adaptive_tag >
{
    static void initialize( pthread_mutex_t &ptm)
    {
#if defined( __USE_GNU )
        static const pthread_mutex_t stored_initializer =
            PTHREAD_ADAPTIVE_MUTEX_INITIALIZER_NP;
        ptm = stored_initializer;
#else
        ZI_VERIFY_0( pthread_mutex_init( &ptm, NULL ) );
#endif
    }
};

template<> struct mutex_initializer< mutex_recursive_tag >
{
#if defined( PTHREAD_RECURSIVE_MUTEX_INITIALIZER_NP )
    static void initialize( pthread_mutex_t &ptm )
    {
        static const pthread_mutex_t stored_initializer =
            PTHREAD_RECURSIVE_MUTEX_INITIALIZER_NP;
        ptm = stored_initializer;
    }
#else

    struct recursive_mutex_initializer_impl
    {
        pthread_mutexattr_t attr_;

        recursive_mutex_initializer_impl()
        {
	    ZI_VERIFY_0( pthread_mutexattr_init( &attr_ ) );
            ZI_VERIFY_0( pthread_mutexattr_settype( &attr_, PTHREAD_MUTEX_RECURSIVE ) );
        }

        ~recursive_mutex_initializer_impl()
        {
            ZI_VERIFY_0( pthread_mutexattr_destroy( &attr_ ) );
        }
    };

    static void initialize( pthread_mutex_t &ptm )
    {
        static recursive_mutex_initializer_impl impl;

        ZI_VERIFY_0( pthread_mutex_init( &ptm, &impl.attr_ ) );

    }

#endif


};



} // namespace concurrency_
} // namespace zi

#endif
