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

#ifndef ZI_CONCURRENCY_STATE_HPP
#define ZI_CONCURRENCY_STATE_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/condition_variable.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

namespace zi {
namespace concurrency_ {

template< class T >
class state: non_copyable
{
public:
    typedef T state_type;

private:
    mutable state_type state_  ;
    condition_variable cv_     ;
    mutex              m_      ;
    int                waiters_;

    void set_to_nl( state_type s ) const
    {
        if ( state_ != s )
        {
            state_ = s;
            if ( waiters_ == 1 )
            {
                cv_.notify_one();
            }
            else if ( waiters_ > 1 )
            {
                cv_.notify_all();
            }
        }
    }

public:

    explicit state( state_type s = state_type() )
        : state_( s ), cv_(), m_(), waiters_( 0 )
    {
    }

    void set_to( state_type s ) const
    {
        mutex::guard g( m_ );
        set_to_nl( s );
    }

    state_type compare_and_set_to( state_type expected, state_type s ) const
    {
        mutex::guard g( m_ );
        if ( state_ == expected )
        {
            set_to_nl( s );
        }
        return state_;
    }

    void wait_for( state_type s ) const
    {
        mutex::guard g( m_ );
        while ( state_ != s )
        {
            ++waiters_;
            cv_.wait( m_ );
            --waiters_;
        }
    }

    state_type operator() () const
    {
        mutex::guard g( m_ );
        return state_;
    }

    state_type get_state() const
    {
        mutex::guard g( m_ );
        return state_;
    }

};



} // namespace concurrency_

using concurrency_::state;

} // namespace zi


#endif
