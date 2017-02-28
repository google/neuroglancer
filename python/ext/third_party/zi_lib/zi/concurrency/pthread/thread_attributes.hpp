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

#ifndef ZI_CONCURRENCY_PTHREAD_THREAD_ATTRIBUTES_HPP
#define ZI_CONCURRENCY_PTHREAD_THREAD_ATTRIBUTES_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/utility/non_copyable.hpp>
#include <zi/utility/singleton.hpp>
#include <zi/utility/assert.hpp>

#include <cstddef>
#include <pthread.h>

namespace zi {
namespace concurrency_ {

namespace tag {

struct detached
{
    static const int value = PTHREAD_CREATE_DETACHED;
};

struct joinable
{
    static const int value = PTHREAD_CREATE_JOINABLE;
};

} // namespace tag

template< class DetachState, std::size_t StackSizeMB = 0 >
struct thread_attributes: non_copyable
{
private:
    typedef thread_attributes< DetachState > this_type;

    pthread_attr_t attr_;

protected:

    thread_attributes(): attr_()
    {
        ZI_VERIFY_0( pthread_attr_init( &attr_ ) );
        ZI_VERIFY_0( pthread_attr_setdetachstate( &attr_, DetachState::value ) );
        if ( StackSizeMB > 0 )
        {
            ZI_VERIFY_0( pthread_attr_setstacksize( &attr_, StackSizeMB ) );
        }
    }

    ~thread_attributes()
    {
        ZI_VERIFY_0( pthread_attr_destroy( &attr_ ) );
    }

public:

    static pthread_attr_t* get()
    {
        static this_type &instance = singleton< this_type >::instance();
        return &instance.attr_;
    }

};

} // namespace concurrency_
} // namespace zi

#endif
