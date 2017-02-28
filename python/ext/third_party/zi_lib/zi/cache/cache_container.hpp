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

#ifndef ZI_CACHE_CONTAINER_FWD_HPP
#define ZI_CACHE_CONTAINER_FWD_HPP 1

#include <zi/cache/config.hpp>

#include <zi/cache/tags.hpp>
#include <zi/cache/detail/multi_index.hpp>
#include <zi/cache/detail/container_entry.hpp>

#include <zi/utility/detail/nbyte_int.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/bits/cstdint.hpp>

#include <cstddef>

namespace zi {
namespace cache {

template< class Tag = default_cache_tag >
class cache_container;

template< class Tag >
class cache_container
{
private:

    typedef detail::container_entry                      entry_t;
    typedef typename ::zi::detail::as_int< void* >::type group_t;

    // index tags
    struct token_tag     {};
    struct group_tag     {};
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
                MULTI_INDEX_MEMBER( entry_t, group_t, group_ )
            >,
            multi_index::ordered_non_unique<
                multi_index::tag< timestamp_tag >,
                MULTI_INDEX_MEMBER( entry_t, int64_t, timestamp_ )
            >
        >
    > index_t;

    typedef typename index_t::iterator iterator_t;
    typedef typename index_t::template index< token_tag >::type     token_index_t    ;
    typedef typename index_t::template index< group_tag >::type     group_index_t    ;
    typedef typename index_t::template index< timestamp_tag >::type timestamp_index_t;

public:

    cache_container();
    ~cache_container();

    template< class Key, class CacheType >
    int64_t insert( CacheType&, const Key& );

    template< class Key >
    int64_t insert( bool (&)( Key const & ), const Key& );

    template< class Key >
    int64_t insert( int64_t, const Key& , function< bool (void) >& );

    template< class CacheType >
    std::size_t count_of( CacheType& ) const;

    template< class CacheType >
    std::size_t clear_group( CacheType& );

    bool touch ( int64_t );
    bool remove( int64_t );

    int64_t age_of( int64_t );
    int64_t oldest_age();
    int64_t oldest_token();

    std::size_t size() const;

private:

    void lock();
    void unlock();

    index_t           index_;
    int64_t           counter_;
    mutex::recursive  mutex_;
    token_index_t     &token_index_;
    group_index_t     &group_index_;
    timestamp_index_t &timestamp_index_;
};

} // namespace cache
} // namespace zi

#endif
