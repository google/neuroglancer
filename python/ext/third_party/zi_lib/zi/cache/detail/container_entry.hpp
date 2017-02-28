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

#ifndef ZI_CACHE_DETAIL_CONTAINER_ENTRY_HPP
#define ZI_CACHE_DETAIL_CONTAINER_ENTRY_HPP 1

#include <zi/cache/config.hpp>
#include <zi/time/now.hpp>
#include <zi/utility/detail/nbyte_int.hpp>
#include <zi/utility/address_of.hpp>
#include <zi/utility/enable_if.hpp>

#include <zi/bits/type_traits.hpp>
#include <zi/bits/function.hpp>
#include <zi/bits/bind.hpp>
#include <zi/bits/ref.hpp>
#include <functional>

namespace zi {
namespace cache {
namespace detail {

struct container_entry
{
    typedef ::zi::detail::as_int< void* >::type    group_t;
    typedef function< bool (void) >                callback_t;

    int64_t     token_          ;
    group_t     group_          ;
    int64_t     timestamp_      ;
    callback_t  flush_callback_ ;

    struct dummy
    {
        dummy(int) {}
    };


    template< class CacheType >
    static typename enable_if< is_integral< CacheType >::value, group_t >::type
    to_group_( CacheType &t )
    {
        return static_cast< group_t >( t );
    }

    template< class CacheType >
    static typename disable_if< is_integral< CacheType >::value, group_t >::type
    to_group_( CacheType &t )
    {
        return reinterpret_cast< group_t >( address_of( t ) );
    }

    template< class CacheType >
    static group_t
    to_group_( CacheType *value_ptr )
    {
        return reinterpret_cast< group_t >( value_ptr );
    }



    // designed to be called with CacheType that has a member int ::flush(K);
    template< class Key, class CacheType > explicit
    container_entry( int64_t token, int64_t timestamp, CacheType& cb, const Key& key ):
        token_( token ),
        group_( to_group_( cb ) ),
        timestamp_( timestamp ),
        flush_callback_( bind( bind( &CacheType::flush, ref( cb ), _1), key ) )
    {
    }

    // used for a entrys with provided function callback bool function( Key ),
    // in which case we manually provide the group ID
    template< class Key > explicit
    container_entry( int64_t token, int64_t timestamp,
                     const Key &key, bool ( &cb )( Key const & ) ):
        token_( token ),
        group_( to_group_( cb ) ),
        timestamp_( timestamp ),
        flush_callback_( bind( function< bool ( Key const & ) >( &cb ), key ) )
    {
    }

    // used for entrys with manually provided flush_callback function
    container_entry( int64_t token, int64_t timestamp, group_t group, callback_t& cb ):
        token_( token ),
        group_( group ),
        timestamp_( timestamp ),
        flush_callback_( cb )
    {
    }

    // provide the flush functionality
    bool try_flush() const
    {
        return flush_callback_();
    }

    struct timestamp_updater
    {
        void operator() ( container_entry &e )
        {
            e.timestamp_ = now::usec();
        }
    };

};

} // namespace detail
} // namespace cache
} // namespace zi

#endif
