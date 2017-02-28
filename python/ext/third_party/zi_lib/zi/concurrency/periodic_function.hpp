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

#ifndef ZI_CONCURRENCY_PERIODIC_FUNCTION_HPP
#define ZI_CONCURRENCY_PERIODIC_FUNCTION_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/condition_variable.hpp>
#include <zi/concurrency/runnable.hpp>
#include <zi/concurrency/mutex.hpp>

#include <zi/bits/shared_ptr.hpp>
#include <zi/bits/function.hpp>
#include <zi/bits/bind.hpp>
#include <zi/bits/ref.hpp>

#include <zi/time/interval.hpp>

#include <cstddef>

namespace zi {
namespace concurrency_ {

struct periodic_function_adapter: runnable
{
private:
    enum state
    {
        IDLE     = 0,
        RUNNING  = 1,
        SLEEPING = 2,
        STOPPING = 3
    };

    function< bool () > f_;
    int64_t             msecs_timeout_;
    state               state_;

    mutex               mutex_;
    condition_variable  running_cv_;
    condition_variable  state_cv_;

    std::size_t         count_;

public:
    periodic_function_adapter( const function< bool() > &f, int64_t msecs_timeout )
        : f_( f ),
          msecs_timeout_( msecs_timeout ),
          state_( IDLE ),
          mutex_(),
          running_cv_(),
          state_cv_(),
          count_( 0 )
    {
    };

    periodic_function_adapter( const reference_wrapper< function< bool() > >& f,
                               int64_t msecs_timeout )
        : f_( f.get() ),
          msecs_timeout_( msecs_timeout ),
          state_( IDLE ),
          mutex_(),
          running_cv_(),
          state_cv_(),
          count_( 0 )
    {
    };

    void run()
    {
        bool ok = true;
        {
            mutex::guard g( mutex_ );

            if ( state_ != IDLE )
            {
                return;
            }

        }

        do
        {
            {
                mutex::guard g( mutex_ );
                state_ = RUNNING;
            }

            ok = f_();

            {
                mutex::guard g( mutex_ );
                ++count_;

                if ( ok && state_ == RUNNING )
                {
                    state_ = SLEEPING;
                    ok = !running_cv_.timed_wait( g, msecs_timeout_ );
                }

            }

        } while( ok );

        {
            mutex::guard g( mutex_ );

            if ( state_ == STOPPING )
            {
                state_ = IDLE;
                state_cv_.notify_all();
            }
            else
            {
                state_ = IDLE;
            }

        }
    }

    void stop()
    {
        mutex::guard g( mutex_ );

        switch ( state_ )
        {
        case IDLE:
            return;

        case RUNNING:
            state_ = STOPPING;
            break;

        case SLEEPING:
            state_ = STOPPING;
            running_cv_.notify_one();
            break;

        default:
            break;
        }

        while ( state_ != IDLE )
        {
            state_cv_.wait( g );
        }
    }

    std::size_t cycles() const
    {
        mutex::guard g( mutex_ );
        return count_;
    }

    void timeout( int64_t msecs_timeout )
    {
        mutex::guard g( mutex_ );
        msecs_timeout_ = msecs_timeout;
    }

    int64_t timeout() const
    {
        mutex::guard g( mutex_ );
        return msecs_timeout_;
    }

};


struct periodic_function
{
private:
    shared_ptr< periodic_function_adapter > f_;

public:
    //
    // As global function
    //

    explicit periodic_function( bool (*f)(), int64_t to )
        : f_( new periodic_function_adapter( f, to ) )
    {
    }

    template< class P1 >
    explicit periodic_function( bool (*f)( P1 ),
                                const P1& p1, int64_t to )
        : f_( new periodic_function_adapter( bind( f, p1 ), to ) )
    {
    }

    template< class P1, class P2 >
    explicit periodic_function( bool (*f)( P1, P2 ),
                                const P1& p1, const P2& p2, int64_t to )
        : f_( new periodic_function_adapter( bind( f, p1, p2 ), to ) )
    {
    }

    template< class P1, class P2, class P3 >
    explicit periodic_function( bool (*f)( P1, P2, P3 ),
                                const P1& p1, const P2& p2, const P3& p3, int64_t to )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3 ), to ) )
    {
    }

    template< class P1, class P2, class P3, class P4 >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4, int64_t to )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4 ), to ) )
    {
    }

    template< class P1, class P2, class P3, class P4,
              class P5 >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4, P5 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, int64_t to )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4, p5 ), to ) )
    {
    }

    template< class P1, class P2, class P3, class P4,
              class P5, class P6 >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4, P5, P6 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, int64_t to )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4, p5, p6 ), to ) )
    {
    }

    template< class P1, class P2, class P3, class P4,
              class P5, class P6, class P7 >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4, P5, P6, P7 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, int64_t to )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4, p5, p6, p7 ), to ) )
    {
    }

    template< class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, class P8 >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4, P5, P6, P7, P8 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, const P8& p8, int64_t to )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4, p5, p6, p7, p8 ), to ) )
    {
    }


    template< int64_t I >
    explicit periodic_function( bool (*f)(),
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( f, itv.msecs() ) )
    {
    }

    template< class P1, int64_t I >
    explicit periodic_function( bool (*f)( P1 ),
                                const P1& p1,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, p1 ), itv.msecs() ) )
    {
    }

    template< class P1, class P2, int64_t I >
    explicit periodic_function( bool (*f)( P1, P2 ),
                                const P1& p1, const P2& p2,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, p1, p2 ), itv.msecs() ) )
    {
    }

    template< class P1, class P2, class P3, int64_t I >
    explicit periodic_function( bool (*f)( P1, P2, P3 ),
                                const P1& p1, const P2& p2, const P3& p3,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3 ), itv.msecs() ) )
    {
    }

    template< class P1, class P2, class P3, class P4, int64_t I >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4 ), itv.msecs() ) )
    {
    }

    template< class P1, class P2, class P3, class P4,
              class P5, int64_t I >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4, P5 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4, p5 ), itv.msecs() ) )
    {
    }

    template< class P1, class P2, class P3, class P4,
              class P5, class P6, int64_t I >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4, P5, P6 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4, p5, p6 ), itv.msecs() ) )
    {
    }

    template< class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, int64_t I >
    explicit periodic_function( bool (*f)( P1, P2, P3, P4, P5, P6, P7 ),
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4, p5, p6, p7 ), itv.msecs() ) )
    {
    }

    template< class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, class P8, int64_t I >
    explicit periodic_function( const function< bool( P1, P2, P3, P4, P5, P6, P7, P8 ) >& f,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, const P8& p8,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, p1, p2, p3, p4, p5, p6, p7, p8 ), itv.msecs() ) )
    {
    }

    //
    // As member function
    //

    template< class T >
    explicit periodic_function( bool (T::*f)(), T* t, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t ), to ) )
    {
    }

    template< class T, class P1 >
    explicit periodic_function( bool (T::*f)( P1 ), T* t,
                                const P1& p1, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1 ), to ) )
    {
    }

    template< class T, class P1, class P2 >
    explicit periodic_function( bool (T::*f)( P1, P2 ), T* t,
                                const P1& p1, const P2& p2, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, class P7 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6, P7 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6, p7 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, class P8 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6, P7, P8 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, const P8& p8, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6, p7, p8 ), to ) )
    {
    }


    template< class T, int64_t I >
    explicit periodic_function( bool (T::*f)(), T* t,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t ), itv.msecs() ) )
    {
    }

    template< class T, class P1, int64_t I >
    explicit periodic_function( bool (T::*f)( P1 ), T* t,
                                const P1& p1,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2 ), T* t,
                                const P1& p1, const P2& p2,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6, P7 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6, p7 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, class P8, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6, P7, P8 ), T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, const P8& p8,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6, p7, p8 ), itv.msecs() ) )
    {
    }


    //
    // As const member function
    //

    template< class T >
    explicit periodic_function( bool (T::*f)() const, const T* t, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t ), to ) )
    {
    }

    template< class T, class P1 >
    explicit periodic_function( bool (T::*f)( P1 ) const, const T* t,
                                const P1& p1, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1 ), to ) )
    {
    }

    template< class T, class P1, class P2 >
    explicit periodic_function( bool (T::*f)( P1, P2 ) const, const T* t,
                                const P1& p1, const P2& p2, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, class P7 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6, P7 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6, p7 ), to ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, class P8 >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6, P7, P8 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, const P8& p8, int64_t to )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6, p7, p8 ), to ) )
    {
    }


    template< class T, int64_t I >
    explicit periodic_function( bool (T::*f)() const, const T* t,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t ), itv.msecs() ) )
    {
    }

    template< class T, class P1, int64_t I >
    explicit periodic_function( bool (T::*f)( P1 ) const, const T* t,
                                const P1& p1,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2 ) const, const T* t,
                                const P1& p1, const P2& p2,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6, P7 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6, p7 ), itv.msecs() ) )
    {
    }

    template< class T, class P1, class P2, class P3, class P4,
              class P5, class P6, class P7, class P8, int64_t I >
    explicit periodic_function( bool (T::*f)( P1, P2, P3, P4, P5, P6, P7, P8 ) const, const T* t,
                                const P1& p1, const P2& p2, const P3& p3, const P4& p4,
                                const P5& p5, const P6& p6, const P7& p7, const P8& p8,
                                const interval::detail::interval_tpl< I > &itv )
        : f_( new periodic_function_adapter( bind( f, t, p1, p2, p3, p4, p5, p6, p7, p8 ), itv.msecs() ) )
    {
    }

    ~periodic_function()
    {
        stop();
    }

    void stop()
    {
        f_->stop();
    }

    std::size_t cycles() const
    {
        return f_->cycles();
    }

    void timeout( int64_t msecs_timeout )
    {
        f_->timeout( msecs_timeout );
    }

    int64_t timeout() const
    {
        return f_->timeout();
    }

    template< int64_t I >
    void timeout( const interval::detail::interval_tpl< I > &itv )
    {
        f_->timeout( itv.msecs() );
    }

    operator shared_ptr< runnable >() const
    {
        return f_;
    }

};


} // namespace concurrency_

using concurrency_::periodic_function;

typedef concurrency_::periodic_function periodic_fn;

} // namespace zi

#endif
