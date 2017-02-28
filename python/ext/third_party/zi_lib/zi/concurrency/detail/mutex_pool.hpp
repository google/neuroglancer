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

#ifndef ZI_CONCURRENCY_DETAIL_MUTEX_POOL_HPP
#define ZI_CONCURRENCY_DETAIL_MUTEX_POOL_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/utility/non_copyable.hpp>

#include <cstddef>

namespace zi {
namespace concurrency_ {

// forward
class condition_variable;

template< class Tag, class Mutex, std::size_t Size = 83 > // 83 is prime!
class mutex_pool: non_copyable
{
public:

    typedef Mutex mutex_type;
    static const std::size_t pool_size = Size;

private:

    static Mutex pool_[ Size ];

public:

    class guard: non_copyable
    {
    public:

        explicit guard( std::size_t ind ):
            m_( pool_[ ind % pool_size ] )
        {
            m_.lock();
        }

        explicit guard( void const * ptr ):
            m_( pool_[ reinterpret_cast< std::size_t >( ptr ) % pool_size ] )
        {
            m_.lock();
        }

        ~guard()
        {
            m_.unlock();
        }

        friend class condition_variable;

    private:

        Mutex &m_;
    };

private:

    friend class guard;

};

template< class Tag, class Mutex, std::size_t Size >
Mutex mutex_pool< Tag, Mutex, Size >::pool_[ Size ];

} // namespace concurrency_

} // namespace zi

#endif
