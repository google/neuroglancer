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

#ifndef ZI_CONCURRENCY_WIN32_EVENT_HPP
#define ZI_CONCURRENCY_WIN32_EVENT_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/win32/mutex_types.hpp>
#include <zi/concurrency/win32/detail/primitives.hpp>
#include <zi/concurrency/win32/detail/interlocked.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

namespace zi {
namespace concurrency_ {


class event: non_copyable
{
private:
    win32::handle         event_;

public:

    event(): event_( win32::CreateEvent( 0, true, false, 0 ) )
    {
        ZI_ASSERT( event_ );
    }

    ~event()
    {
        ZI_VERIFY( win32::CloseHandle( event_ ) );
    }

    template< class MutexTag >
    void wait( const mutex_tpl< MutexTag > &mutex ) const
    {
        mutex.unlock();
        win32::WaitForSingleObject( event_, win32::forever );
        mutex.lock();
    }

    template< class Mutex >
    void wait( const mutex_guard< Mutex > &g ) const
    {
        g.m_.unlock();
        win32::WaitForSingleObject( event_, win32::forever );
        g.m_.lock();
    }

    void signal() const
    {
        win32::SetEvent( event_ );
    }

    void clear() const
    {
        win32::ResetEvent( event_ );
    }

};


} // namespace concurrency_
} // namespace zi

#endif
