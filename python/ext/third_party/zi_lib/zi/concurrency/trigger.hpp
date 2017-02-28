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

#ifndef ZI_CONCURRENCY_TRIGGER_HPP
#define ZI_CONCURRENCY_TRIGGER_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/condition_variable.hpp>

#include <zi/bits/shared_ptr.hpp>
#include <zi/bits/unordered_map.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

#include <stdexcept>

namespace zi {
namespace concurrency_ {

class trigger_impl: non_copyable
{
private:
    mutable bool               t_  ;
    mutable int                w_  ;
    mutex              m_  ;
    condition_variable cv_ ;

    bool valid_for_destruction() const
    {
        mutex::guard g( m_ );
        return w_ == 0;
    }

public:

    trigger_impl()
        : t_( false ), w_(0), m_(), cv_()
    { }

    ~trigger_impl()
    {
        ZI_ASSERT( valid_for_destruction() );
    }

    void wait() const
    {
        mutex::guard g( m_ );
        if ( !t_ )
        {
            ++w_;
            cv_.wait( m_ );
            --w_;
        }
    }

    void fire() const
    {
        m_.lock();
        t_ = true;
        m_.unlock();

        cv_.notify_all();
    }


};

template< class T >
class trigger_pool_wrapper
{
    template< class K >
    class pool: non_copyable
    {
    private:
        mutex                         m_   ;
        mutable unordered_map< K, T > pool_;

    public:
        void wait( const K& key ) const
        {
            mutex::guard g( m_ );
            pool_[ key ].wait();
        }

        void fire( const K& key ) const
        {
            mutex::guard g( m_ );
            pool_[ key ].fire();
            pool_.erase( key );
        }

        void operator()( const K& key ) const
        {
            fire( key );
        }
    };
};

class trigger: public trigger_pool_wrapper< trigger >
{
private:
    shared_ptr< trigger_impl > t_;

public:
    trigger()
        : t_( new trigger_impl() )
    { }

    explicit trigger( const trigger& rcp )
        : t_( rcp.t_ )
    { }

    trigger& operator=( const trigger& rcp )
    {
        t_ = rcp.t_;
        return *this;
    }

    void wait() const
    {
        t_->wait();
    }

    void fire() const
    {
        t_->fire();
    }

    void operator()() const
    {
        t_->fire();
    }

};

} // namespace concurrency_

using concurrency_::trigger;

} // namespace zi


#endif
