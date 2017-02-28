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

#ifndef ZI_CONCURRENCY_TASK_MANAGER_HPP
#define ZI_CONCURRENCY_TASK_MANAGER_HPP 1

#include <zi/concurrency/detail/task_manager_impl.hpp>
#include <zi/concurrency/detail/simple_task_container.hpp>
#include <zi/concurrency/detail/priority_task_container.hpp>

#include <zi/bits/type_traits.hpp>
#include <zi/meta/enable_if.hpp>

namespace zi {
namespace concurrency_ {

template< class TaskContainer >
class task_manager_tpl
{
private:
    typedef task_manager_impl< TaskContainer > task_manager_t;
    shared_ptr< task_manager_t > manager_;

public:
    task_manager_tpl( std::size_t worker_limit,
                      std::size_t max_size = std::numeric_limits< std::size_t >::max() ) :
        manager_( new task_manager_t( worker_limit, max_size ) )
    {
    }


    std::size_t empty()
    {
        return manager_->empty();
    }

    std::size_t idle()
    {
        return manager_->empty();
    }

    std::size_t size()
    {
        return manager_->size();
    }

    std::size_t worker_count()
    {
        return manager_->worker_count();
    }

    std::size_t worker_limit()
    {
        return manager_->worker_limit();
    }

    std::size_t idle_workers()
    {
        return manager_->idle_workers();
    }

    bool start()
    {
        return manager_->start();
    }

    void stop( bool and_join = false )
    {
        return manager_->stop( and_join );
    }

    void join()
    {
        manager_->join();
    }

    void push_front( shared_ptr< runnable > task, std::size_t count = 1 )
    {
        for ( ; count > 0; -- count )
        {
            manager_->push_front( task );
        }
    }

    template< class Runnable >
    void push_front( shared_ptr< Runnable > task,
                    std::size_t count = 1,
                    typename meta::enable_if<
                    typename is_base_of< runnable, Runnable >::type >::type* = 0 )
    {
        for ( ; count > 0; -- count )
        {
            manager_->push_front( task );
        }
    }

    template< class Function >
    void push_front( const Function& task,
                    typename meta::enable_if<
                    typename is_convertible< Function, function< void() >
                    >::type >::type* = 0 )
    {
        push_front( shared_ptr< runnable_function_wrapper >
                   ( new runnable_function_wrapper( task ) ));
    }


    void push_back( shared_ptr< runnable > task, std::size_t count = 1 )
    {
        for ( ; count > 0; -- count )
        {
            manager_->push_back( task );
        }
    }

    template< class Runnable >
    void push_back( shared_ptr< Runnable > task,
                    std::size_t count = 1,
                    typename meta::enable_if<
                    typename is_base_of< runnable, Runnable >::type >::type* = 0 )
    {
        for ( ; count > 0; -- count )
        {
            manager_->push_back( task );
        }
    }

    template< class Function >
    void push_back( const Function& task,
                    std::size_t count = 1,
                    typename meta::enable_if<
                    typename is_convertible< Function, function< void() >
                    >::type >::type* = 0 )
    {
        this->push_back( shared_ptr< runnable_function_wrapper >
                         ( new runnable_function_wrapper( task ) ), count );
    }

    void add_task( shared_ptr< runnable > task, std::size_t count = 1 )
    {
        push_back( task, count );
    }

    template< class Runnable >
    void add_task( shared_ptr< Runnable > task,
                    std::size_t count = 1,
                    typename meta::enable_if<
                    typename is_base_of< runnable, Runnable >::type >::type* = 0 )
    {
        this->template push_back< Runnable >( task, count );
    }

    template< class Function >
    void add_task( const Function& task,
                   typename meta::enable_if<
                   typename is_convertible< Function, function< void() >
                   >::type >::type* = 0 )
    {
        add_task( shared_ptr< runnable_function_wrapper >
                  ( new runnable_function_wrapper( task ) ));
    }

    void insert( shared_ptr< runnable > task, std::size_t count = 1 )
    {
        push_back( task, count );
    }


    template< class Runnable >
    void insert( shared_ptr< Runnable > task,
                 std::size_t count = 1,
                 typename meta::enable_if<
                 typename is_base_of< runnable, Runnable >::type >::type* = 0 )
    {
        this->template insert< Runnable >( task, count );
    }

    template< class Function >
    void insert( const Function& task,
                 typename meta::enable_if<
                 typename is_convertible< Function, function< void() >
                 >::type >::type* = 0 )
    {
        insert( shared_ptr< runnable_function_wrapper >
                ( new runnable_function_wrapper( task ) ));
    }


    template< class Tag >
    void push_front( shared_ptr< runnable > task, std::size_t count = 1 )
    {
        for ( ; count > 0; -- count )
        {
            manager_->template push_front< Tag >( task );
        }
    }

    template< class Tag >
    void push_back( shared_ptr< runnable > task, std::size_t count = 1 )
    {
        for ( ; count > 0; -- count )
        {
            manager_->template push_back< Tag >( task );
        }
    }

    template< class Tag >
    void add_task( shared_ptr< runnable > task, std::size_t count = 1 )
    {
        push_back< Tag >( task, count );
    }

    template< class Tag >
    void insert( shared_ptr< runnable > task, std::size_t count = 1 )
    {
        push_back< Tag >( task, count );
    }

    void clear()
    {
        manager_->clear();
    }

    void add_workers( std::size_t count )
    {
        manager_->add_workers( count );
    }

    void remove_workers( std::size_t count )
    {
        manager_->remove_workers( count );
    }

};



} // namespace concurrency_

namespace task_manager {

typedef concurrency_::task_manager_tpl< concurrency_::detail::simple_task_container >   simple     ;
typedef concurrency_::task_manager_tpl< concurrency_::detail::simple_task_container >   deque      ;
typedef concurrency_::task_manager_tpl< concurrency_::detail::priority_task_container > prioritized;

} // namespace task_manager

} // namespace zi

#endif

