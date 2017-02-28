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

#ifndef ZI_CONCURRENCY_SEMAPHORE_HPP
#define ZI_CONCURRENCY_SEMAPHORE_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/condition_variable.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

#include <algorithm>

namespace zi {
namespace concurrency_ {


class semaphore: non_copyable
{
private:

    mutable int64_t credit_   ;
    mutable int64_t waiters_  ;

    condition_variable cv_;
    mutex              m_ ;

public:

    explicit semaphore( int64_t count = 0 ):
        credit_( count ), waiters_( 0 ), cv_(), m_()
    {
        ZI_ASSERT( count >= 0 );
    }

    void set( int64_t n ) const
    {
        mutex::guard g( m_ );

        credit_ = n;

        if( n )
        {
            cv_.notify_one();
        }
    }

    void acquire( int64_t n = 1 ) const
    {
        mutex::guard g( m_ );

        while ( credit_ < n )
        {
            ++waiters_;
            cv_.wait( m_ );
            --waiters_;
        }

        credit_ -= n;
    }

    bool timed_acquire( int64_t ttl ) const
    {
        mutex::guard g( m_ );

        int64_t end_at = now::msec() + ttl;

        while ( credit_ <= 0 )
        {
            int64_t rest = end_at - now::msec();

            if ( rest < 0 )
            {
                return false;
            }

            ++waiters_;
            bool ok = cv_.timed_wait( m_, rest );
            --waiters_;

            if ( !ok )
            {
                return false;
            }

        }

        --credit_;

        return true;
    }

    void release( int64_t n = 1 ) const
    {
        mutex::guard g( m_ );

        credit_ += n;

        n = std::min( n, waiters_ );

        if ( n > 0 )
        {
            if ( n > 1 )
            {
                if ( ( n >> 1 ) >= waiters_ )
                {
                    cv_.notify_all();
                }
                else
                {
                    while ( n > 0 )
                    {
                        cv_.notify_one();
                        --n;
                    }
                }
            }
            else
            {
                cv_.notify_one();
            }
        }
    }

    class synchronized: non_copyable
    {
    private:

        const semaphore &s_;

    public:

        synchronized( const semaphore &s ): s_( s )
        {
            s_.acquire();
        }

        ~synchronized()
        {
            s_.release();
        }

    };

    typedef synchronized guard;

};


} // namespace concurrency_

using concurrency_::semaphore;

} // namespace zi


#endif
