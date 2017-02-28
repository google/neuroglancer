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

#ifndef ZI_CACHE_STORAGE_FWD_HPP
#define ZI_CACHE_STORAGE_FWD_HPP 1

#include <zi/cache/config.hpp>

#include <zi/cache/tags.hpp>
#include <zi/cache/detail/multi_index.hpp>
#include <zi/cache/detail/storage_entry.hpp>

#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/guard.hpp>
#include <zi/bits/cstdint.hpp>

#include <cstddef>

namespace zi {
namespace cache {
namespace detail {

class cache_storage
{
private:

    typedef detail::storage_entry entry_t;

    // index tags
    struct token_tag     {};
    struct group_tag     {};
    struct size_tag      {};
    struct timestamp_tag {};

    typedef multi_index_container<
        entry_t,
        multi_index::indexed_by<
            multi_index::hashed_unique<
                multi_index::tag< token_tag >,
                MULTI_INDEX_MEMBER( entry_t, int64_t, token_ )
            >,
            multi_index::hashed_non_unique<
                multi_index::tag< group_tag >,
                MULTI_INDEX_MEMBER( entry_t, int64_t, group_ )
            >,
            multi_index::ordered_non_unique<
                multi_index::tag< timestamp_tag >,
                MULTI_INDEX_MEMBER( entry_t, int64_t, timestamp_ )
            >,
            multi_index::ordered_non_unique<
                multi_index::tag< size_tag >,
                MULTI_INDEX_MEMBER( entry_t, int64_t, size_ )
            >
        >
    > index_t;

    typedef index_t::iterator iterator_t;
    typedef index_t::index< token_tag >::type     token_index_t    ;
    typedef index_t::index< group_tag >::type     group_index_t    ;
    typedef index_t::index< size_tag  >::type     size_index_t     ;
    typedef index_t::index< timestamp_tag >::type timestamp_index_t;

public:

    cache_storage():
        index_(),
        counter_( 0 ),
        mutex_(),
        token_index_(     index_.get< token_tag     >() ),
        group_index_(     index_.get< group_tag     >() ),
        size_index_ (     index_.get< size_tag      >() ),
        timestamp_index_( index_.get< timestamp_tag >() )
    {
    }

    ~cache_storage() {}

    int64_t insert( int64_t group, entry_t::callback_t callback, int64_t size = 0 )
    {
        guard g( mutex_ );
        index_.insert( entry_t( ++counter_, group, callback, size ) );
        return counter_;
    }

    int64_t insert( int64_t group,
                    const reference_wrapper< entry_t::callback_t > &callback,
                    int64_t size = 0 )
    {
        guard g( mutex_ );
        index_.insert( entry_t( ++counter_, group, callback, size ) );
        return counter_;
    }

    std::size_t count_of( int64_t group ) const
    {
        guard g( mutex_ );
        return group_index_.count( group );
    }

    std::size_t clear_group_without_callbacks( int64_t group )
    {
        guard g( mutex_ );
        return group_index_.erase( group );
    }

    bool touch( int64_t token )
    {
        guard g( mutex_ );
        iterator_t it = token_index_.find( token );

        if ( it != index_.end() )
        {
            index_.modify( it, entry_t::timestamp_updater() );
            return true;
        }
        return false;
    }

    bool update_size( int64_t token, int64_t size )
    {
        guard g( mutex_ );
        iterator_t it = token_index_.find( token );

        if ( it != index_.end() )
        {
            index_.modify( it, entry_t::size_updater( size ) );
            return true;
        }
        return false;
    }

    bool remove( int64_t token )
    {
        guard g( mutex_ );
        iterator_t it = token_index_.find( token );

        if ( it != index_.end() )
        {
            it->flush();
            index_.erase( token );
            return true;
        }
        return false;
    }

    bool remove_without_flush_callback( int64_t token )
    {
        guard g( mutex_ );
        iterator_t it = token_index_.find( token );

        if ( it != index_.end() )
        {
            index_.erase( token );
            return true;
        }
        return false;
    }

    int64_t age_of( int64_t token ) const
    {
        guard g( mutex_ );
        iterator_t it = token_index_.find(token);

        if ( it != index_.end() )
        {
            return now::usec() - it->timestamp_;
        }

        return std::numeric_limits< int64_t >::max();
    }

    int64_t oldest_age() const
    {
        guard g( mutex_ );

        if ( index_.size() )
        {
            return now::usec() - timestamp_index_.begin()->timestamp_;
        }

        return std::numeric_limits< int64_t >::max();
    }


    int64_t oldest_token() const
    {
        guard g( mutex_ );

        if ( index_.size() )
        {
            return timestamp_index_.begin()->token_;
        }

        return std::numeric_limits< int64_t >::min();
    }

    std::size_t size() const
    {
        return index_.size();
    }

private:

    index_t           index_   ;
    int64_t           counter_ ;
    mutex::recursive  mutex_   ;
    token_index_t     &token_index_    ;
    group_index_t     &group_index_    ;
    size_index_t      &size_index_     ;
    timestamp_index_t &timestamp_index_;
};

} // namespace detail
} // namespace cache
} // namespace zi

#endif
