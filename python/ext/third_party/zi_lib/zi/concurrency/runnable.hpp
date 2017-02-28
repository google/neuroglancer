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

#ifndef ZI_CONCURRENCY_RUNNABLE_HPP
#define ZI_CONCURRENCY_RUNNABLE_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/mutex.hpp>

#include <zi/bits/shared_ptr.hpp>
#include <zi/bits/function.hpp>
#include <zi/bits/bind.hpp>
#include <zi/bits/ref.hpp>
#include <zi/utility/assert.hpp>

namespace zi {
namespace concurrency_ {

// forward decls
struct thread;

struct runnable: private non_copyable
{
private:
    struct mutex_pool_tag;

    int   running_count_ ;
    int   finished_count_;

    mutex m_;

    void start()
    {
        mutex::guard g( m_ );
        ++running_count_;
    }

    void finish()
    {
        mutex::guard g( m_ );
        --running_count_;
        ++finished_count_;
    }

public:

    runnable():
        running_count_( 0 ),
        finished_count_( 0 )
    {
    }

    virtual ~runnable()
    {
        ZI_ASSERT( running_count_ == 0 );
    }

    virtual void run() = 0;

    void execute()
    {
        start();
        run();
        finish();
    }

protected:

    int finished_count() const
    {
        mutex::guard g( m_ );
        return finished_count_;
    }

    int started_count() const
    {
        mutex::guard g( m_ );
        return finished_count_ + running_count_;
    }

    int active_count() const
    {
        mutex::guard g( m_ );
        return running_count_;
    }

};

struct runnable_function_wrapper: runnable, private function< void() >
{
    runnable_function_wrapper( function< void() > f )
        : zi::function< void() >( f )
    {
    };

    runnable_function_wrapper( const reference_wrapper< function< void() > >& f )
        : zi::function< void() >( f.get() )
    {
    };

    void run()
    {
        zi::function< void() >::operator() ();
    }
};

inline shared_ptr< runnable > run_fn( function< void() > f )
{
    return shared_ptr< runnable_function_wrapper >( new runnable_function_wrapper( f ) );
}

} // namespace concurrency_

using concurrency_::runnable;
using concurrency_::run_fn;

} // namespace zi

#endif
