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

#ifndef ZI_LIBS_CACHE_CONTAINER_HPP
#define ZI_LIBS_CACHE_CONTAINER_HPP 1

#include <zi/cache/container_fwd.hpp>

#include <zi/concurrency/guard.hpp>
#include <zi/time/now.hpp>
#include <zi/utility/for_each.hpp>
#include <zi/bits/cstdint.hpp>

#include <limits>

namespace zi {
namespace cache {

template< class Tag >
cache_container< Tag >::cache_container():
    index_(),
    counter_( 0 ),
    mutex_(),
    token_index_(     index_.template get< token_tag     >() ),
    group_index_(     index_.template get< group_tag     >() ),
    timestamp_index_( index_.template get< timestamp_tag >() )
{
}

template< class Tag >
template< class Key, class CacheType >
inline int64_t
cache_container< Tag >::insert( CacheType &cb_obj, const Key &key )
{
    guard g( mutex_ );
    index_.insert( entry_t( ++counter_, now::usec(), cb_obj, key ) );
    return counter_;
}

template< class Tag >
template< class Key >
inline int64_t
cache_container< Tag >::insert( bool ( &cb_fn )( Key const & ), const Key& key)
{
    guard g( mutex_ );
    index_.insert( entry_t( ++counter_, now::usec(), key, cb_fn ) );
    return counter_;
}


template< class Tag >
template< class Key >
inline int64_t
cache_container< Tag >::insert( int64_t group, const Key& key, function< bool (void) >& cb_fn )
{
    guard g( mutex_ );
    index_.insert( entry_t( ++counter_, now::usec(), group, key, cb_fn ) );
    return counter_;
}

template< class Tag >
template< class CacheType >
inline std::size_t
cache_container< Tag >::count_of( CacheType &t ) const
{
    guard g( mutex_ );
    return group_index_.count( detail::container_entry::to_group_( t ) );
}

template< class Tag >
template< class CacheType >
inline std::size_t
cache_container< Tag >::clear_group( CacheType &t )
{
    guard g( mutex_ );
    return group_index_.erase( detail::container_entry::to_group_( t ) );
}

template< class Tag >
inline bool
cache_container< Tag >::touch ( int64_t token )
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

template< class Tag >
inline bool
cache_container< Tag >::remove( int64_t token )
{
    // todo: no callback? called from the owner!
    guard g( mutex_ );
    iterator_t it = token_index_.find( token );

    if ( it != index_.end() )
    {
        if ( it->try_flush() )
        {
            index_.erase( token );
        }
    }

    return false;
}

template< class Tag >
inline int64_t
cache_container< Tag >::age_of( int64_t token )
{
    guard g( mutex_ );
    iterator_t it = token_index_.find(token);

    if ( it != index_.end() )
    {
        return now::usec() - it->timestamp_;
    }

    return std::numeric_limits< int64_t >::max();
}

template< class Tag >
inline int64_t
cache_container< Tag >::oldest_age()
{
    guard g( mutex_ );

    if ( index_.size() )
    {
        return now::usec() - timestamp_index_.begin()->timestamp_;
    }

    return std::numeric_limits< int64_t >::max();
}

template< class Tag >
inline int64_t
cache_container< Tag >::oldest_token()
{
    guard g( mutex_ );

    if ( index_.size() )
    {
        return timestamp_index_.begin()->token_;
    }

    return std::numeric_limits< int64_t >::min();
}

template< class Tag >
inline std::size_t
cache_container< Tag >::size() const
{
    return index_.size();
}

template< class Tag >
inline cache_container< Tag >::~cache_container()
{
    // don't do this since the holding object might
    // be already destroyed!
    //
    // FOR_EACH (it, index_)
    // {
    //     it->try_flush();
    // }
}

template< class Tag >
inline void
cache_container< Tag >::lock()
{
    mutex_.lock();
}

template< class Tag >
inline void
cache_container< Tag >::unlock()
{
    mutex_.unlock();
}

} // namespace cache
} // namespace zi

#endif
