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

#ifndef ZI_CONCURRENCY_MONITOR_HPP
#define ZI_CONCURRENCY_MONITOR_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/condition_variable.hpp>

#include <zi/bits/function.hpp>
#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>
#include <zi/time/now.hpp>

#include <cstddef>

namespace zi {
namespace concurrency_ {


class monitor: non_copyable
{
private:

    const mutex        &m_      ;
    condition_variable  cv_     ;
    mutable int         waiters_;

public:

    class synchronized;

    explicit monitor( const mutex &m ): m_( m ), cv_(), waiters_( 0 )
    {
    }

private:

    void lock() const
    {
        m_.lock();
    }

    void unlock() const
    {
        m_.unlock();
    }

    void wait() const
    {
        ++waiters_;
        cv_.wait( m_ );
        --waiters_;
    }

    bool timed_wait(int64_t ttl) const
    {
        ++waiters_;
        return cv_.timed_wait( m_, ttl );
        --waiters_;
    }

    void notify_one() const
    {
        cv_.notify_one();
    }

    void notify_all() const
    {
        cv_.notify_all();
    }

public:

    class synchronized: non_copyable
    {
    private:

        const monitor &m_;

    public:

        synchronized( const monitor &s ): m_( s )
        {
            m_.lock();
        }

        ~synchronized()
        {
            m_.unlock();

            if ( m_.waiters_ > 0 )
            {
                m_.notify_one();
            }
        }

        void wait() const
        {
            m_.wait();
        }

        bool timed_wait( int64_t ttl ) const
        {
            return m_.timed_wait( ttl );
        }

        void notify_one() const
        {
            m_.notify_one();
        }

        void notify_all() const
        {
            m_.notify_all();
        }

        void wait_for( function< bool (void) > f ) const
        {
            while ( !f() )
            {
                m_.wait();
            }
        }

        template< class F, class A1 >
        void wait_for( F f, const A1& a1 ) const
        {
            while ( !f( a1 ) )
            {
                m_.wait();
            }
        }

        template< class F, class A1, class A2 >
        void wait_for( F f, const A1& a1, const A2& a2 ) const
        {
            while ( !f( a1, a2 ) )
            {
                m_.wait();
            }
        }

        template< class F, class A1, class A2, class A3 >
        void wait_for( F f, const A1& a1, const A2& a2, const A3& a3 ) const
        {
            while ( !f( a1, a2, a3 ) )
            {
                m_.wait();
            }
        }

        template< class F, class A1, class A2, class A3, class A4 >
        void wait_for( F f, const A1& a1, const A2& a2, const A3& a3, const A4& a4 ) const
        {
            while ( !f( a1, a2, a3, a4 ) )
            {
                m_.wait();
            }
        }

        template< class V >
        void wait_true( const V& v ) const
        {
            const volatile V& cvv = reinterpret_cast< const volatile V& >( v );

            while ( !(cvv) )
            {
                m_.wait();
            }
        }

        template< class V >
        void wait_false( const V& v ) const
        {
            const volatile V& cvv = reinterpret_cast< const volatile V& >( v );

            while ( cvv )
            {
                m_.wait();
            }
        }

        template< class L, class R >
        void wait_equals( const L& l, const R& r ) const
        {
            const volatile L& cvl = reinterpret_cast< const volatile L& >( l );
            const volatile R& cvr = reinterpret_cast< const volatile R& >( r );
            while ( cvl != cvr )
            {
                m_.wait();
            }
        }

        template< class L, class R >
        void wait_gt( const L& l, const R& r ) const
        {
            const volatile L& cvl = reinterpret_cast< const volatile L& >( l );
            const volatile R& cvr = reinterpret_cast< const volatile R& >( r );
            while ( cvl <= cvr )
            {
                m_.wait();
            }
        }

        template< class L, class R >
        void wait_gte( const L& l, const R& r ) const
        {
            const volatile L& cvl = reinterpret_cast< const volatile L& >( l );
            const volatile R& cvr = reinterpret_cast< const volatile R& >( r );
            while ( cvl < cvr )
            {
                m_.wait();
            }
        }

        template< class L, class R >
        void wait_lt( const L& l, const R& r ) const
        {
            const volatile L& cvl = reinterpret_cast< const volatile L& >( l );
            const volatile R& cvr = reinterpret_cast< const volatile R& >( r );
            while ( cvl >= cvr )
            {
                m_.wait();
            }
        }

        template< class L, class R >
        void wait_lte( const L& l, const R& r ) const
        {
            const volatile L& cvl = reinterpret_cast< const volatile L& >( l );
            const volatile R& cvr = reinterpret_cast< const volatile R& >( r );
            while ( cvl > cvr )
            {
                m_.wait();
            }
        }

        template< class L, class R >
        void wait_neq( const L& l, const R& r ) const
        {
            const volatile L& cvl = reinterpret_cast< const volatile L& >( l );
            const volatile R& cvr = reinterpret_cast< const volatile R& >( r );
            while ( cvl == cvr )
            {
                m_.wait();
            }
        }

    };

    typedef synchronized guard;


};



} // namespace concurrency_

using concurrency_::monitor;

} // namespace zi


#endif
