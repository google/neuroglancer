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

#ifndef ZI_CONCURRENCY_DETAIL_RWMUTEX_IMPL_HPP
#define ZI_CONCURRENCY_DETAIL_RWMUTEX_IMPL_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/condition_variable.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

#include <zi/bits/cstdint.hpp>
#include <zi/time/interval.hpp>

#include <zi/meta/enable_if.hpp>

namespace zi {
namespace concurrency_ {

class rwmutex_impl: zi::non_copyable
{
private:

    mutable uint32_t reader_count_  ;
    mutable bool     has_writer_    ;
    mutable bool     writer_waiting_;
    mutable bool     upgratable_    ;

    mutex              mutex_     ;
    condition_variable reader_cv_ ;
    condition_variable writer_cv_ ;
    condition_variable upgrade_cv_;

public:

    rwmutex_impl()
        : reader_count_( 0 ),
          has_writer_( false ),
          writer_waiting_( false ),
          upgratable_( false ),
          mutex_(),
          reader_cv_(),
          writer_cv_(),
          upgrade_cv_()
    { }

    bool try_acquire_read() const
    {
        mutex::guard g( mutex_ );

        if ( has_writer_ || writer_waiting_ )
        {
            return false;
        }

        ++reader_count_;
        return true;
    }

    void acquire_read() const
    {
        mutex::guard g( mutex_ );

        while ( has_writer_ || writer_waiting_ )
        {
            reader_cv_.wait( mutex_ );
        }

        ++reader_count_;
    }

    template< class T >
    typename meta::enable_if< is_time_interval< T >, bool >::type
    timed_acquire_read( const T& ttl ) const
    {
        mutex::guard g( mutex_ );

        while ( has_writer_ || writer_waiting_ )
        {
            if ( !reader_cv_.timed_wait( mutex_, ttl ) )
            {
                return false;
            }
        }

        ++reader_count_;
        return true;
    }

    bool timed_acquire_read( int64_t ttl ) const
    {
        return timed_acquire_read( interval::msecs( ttl ) );
    }

    void release_read() const
    {
        mutex::guard g( mutex_ );

        if ( !--reader_count_ )
        {
            if ( upgratable_ )
            {
                upgratable_     = false;
                has_writer_     = true ;
                upgrade_cv_.notify_one();
            }
            else
            {
                writer_waiting_ = false;
            }
            writer_cv_.notify_one();
            reader_cv_.notify_all();
        }
    }

    bool try_acquire_write() const
    {
        mutex::guard g( mutex_ );

        if ( reader_count_ || has_writer_ )
        {
            return false;
        }

        has_writer_ = true;
        return true;
    }

    void acquire_write() const
    {
        mutex::guard g( mutex_ );

        while ( reader_count_ || has_writer_ )
        {
            writer_waiting_ = true;
            writer_cv_.wait( mutex_ );
        }

        has_writer_ = true;
    }

    void release_write() const
    {
        mutex::guard g( mutex_ );
        has_writer_ = writer_waiting_ = false;
        writer_cv_.notify_one();
        reader_cv_.notify_all();
    }


    template< class T >
    typename meta::enable_if< is_time_interval< T >, bool >::type
    timed_acquire_write( const T& ttl ) const
    {
        mutex::guard g( mutex_ );
        while ( reader_count_ || has_writer_ )
        {
            writer_waiting_ = true;
            if ( !writer_cv_.timed_wait( mutex_, ttl ) )
            {
                if ( reader_count_ || has_writer_ )
                {
                    writer_waiting_ = false;
                    writer_cv_.notify_one();
                    return false;
                }
                has_writer_ = true;
                return true;
            }
        }
    }

    bool timed_acquire_write( int64_t ttl ) const
    {
        return timed_acquire_write( interval::msecs( ttl ) );
    }

    bool try_acquire_undecided() const
    {
        mutex::guard g( mutex_ );

        if ( has_writer_ || writer_waiting_ || upgratable_ )
        {
            return false;
        }

        ++reader_count_   ;
        upgratable_ = true;
        return true;
    }

    void acquire_undecided() const
    {
        mutex::guard g( mutex_ );

        while ( has_writer_ || writer_waiting_ || upgratable_ )
        {
            reader_cv_.wait( mutex_ );
        }

        ++reader_count_   ;
        upgratable_ = true;
    }

    void release_undecided() const
    {
        mutex::guard g( mutex_ );
        upgratable_ = false;

        if ( !--reader_count_ )
        {
            writer_waiting_ = false;
            writer_cv_.notify_one();
            reader_cv_.notify_all();
        }
    }

    void decide_read() const
    {
        mutex::guard g( mutex_ );
        upgratable_     = false;
        writer_waiting_ = false;
        writer_cv_.notify_one();
        reader_cv_.notify_all();
    }

    void decide_write() const
    {
        mutex::guard g( mutex_ );
        --reader_count_;

        while ( reader_count_ )
        {
            upgrade_cv_.wait( mutex_ );
        }

        upgratable_ = false;
        has_writer_ = true ;
    }

    void write_to_undecided() const
    {
        mutex::guard g( mutex_ );
        ++reader_count_;
        upgratable_     = true ;
        has_writer_     = false;
        writer_waiting_ = false;
        writer_cv_.notify_one();
        reader_cv_.notify_all();
    }

    void write_to_read() const
    {
        mutex::guard g( mutex_ );
        ++reader_count_;
        has_writer_     = false;
        writer_waiting_ = false;
        writer_cv_.notify_one();
        reader_cv_.notify_all();
    }

    template< class T >
    typename meta::enable_if< is_time_interval< T >, bool >::type
    timed_acquire_undecided( const T& ttl ) const
    {
        mutex::guard g( mutex_ );

        while ( has_writer_ || writer_waiting_ || upgratable_ )
        {
            if ( !reader_cv_.timed_wait( mutex_, ttl ) )
            {
                if ( has_writer_ || writer_waiting_ || upgratable_ )
                {
                    return false;
                }
                ++reader_count_;
                upgratable_ = true;
                return true;
            }
        }
    }

    bool timed_acquire_undecided( int64_t ttl ) const
    {
        return timed_acquire_undecided( interval::msecs( ttl ) );
    }


    class read_guard
    {
    private:
        const rwmutex_impl &m_;

    public:
        explicit read_guard( const rwmutex_impl &m ): m_( m )
        {
            m_.acquire_read();
        }

        ~read_guard()
        {
            m_.release_read();
        }
    };

    class write_guard
    {
    private:
        const rwmutex_impl &m_;

    public:
        explicit write_guard( const rwmutex_impl &m ): m_( m )
        {
            m_.acquire_write();
        }

        ~write_guard()
        {
            m_.release_write();
        }
    };

    typedef write_guard guard;

};

} // namespace concurrency_
} // namespace zi

#endif
