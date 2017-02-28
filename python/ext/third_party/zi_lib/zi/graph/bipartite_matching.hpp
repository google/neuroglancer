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

#ifndef ZI_GRAPH_BIPARTITE_MATCHING_HPP
#define ZI_GRAPH_BIPARTITE_MATCHING_HPP 1

#include <zi/bits/unordered_map.hpp>
#include <zi/bits/cstdint.hpp>
#include <zi/utility/for_each.hpp>
#include <zi/utility/non_copyable.hpp>

#include <cstddef>
#include <vector>
#include <utility>
#include <algorithm>
#include <limits>
#include <queue>
#include <iostream>

namespace zi {
namespace graph {

namespace detail {

template< class VL, class VR >
class hopcroft_karp_impl: non_copyable
{
private:
    std::vector< std::pair< uint32_t, uint32_t > > e_;
    unordered_map< VL, uint32_t > vl_;
    unordered_map< VR, uint32_t > vr_;
    std::vector< uint32_t >      pair_;
    std::vector< uint32_t >      dist_;

    static const uint32_t inf;
    static const uint32_t nil;

    bool bfs()
    {
        std::deque< uint32_t > queue;

        for ( uint32_t v = 1; v <= vl_.size(); ++ v )
        {
            if ( pair_[ v ] == nil )
            {
                dist_[ v ] = 0;
                queue.push_back( v );
            }
            else
            {
                dist_[ v ] = inf;
            }
        }
        dist_[ nil ] = inf;

        while ( queue.size() > 0 )
        {
            uint32_t v = queue[ 0 ];
            queue.pop_front();

            if ( v != nil )
            {
                std::vector< std::pair< uint32_t, uint32_t > >::iterator it
                    = upper_bound( e_.begin(), e_.end(),
                                   std::pair< uint32_t, uint32_t >( v, 0 ) );

                for ( ; it != e_.end() && it->first == v; ++it )
                {
                    if ( dist_[ pair_[ it->second ] ] == inf )
                    {
                        dist_[ pair_[ it->second ] ] = dist_[ v ] + 1;
                        queue.push_back( pair_[ it->second ] );
                    }
                }
            }
        }

        return dist_[ nil ] != inf;
    }


    bool dfs( uint32_t v )
    {
        if ( v != nil )
        {
            std::vector< std::pair< uint32_t, uint32_t > >::iterator it
                = upper_bound( e_.begin(), e_.end(),
                               std::pair< uint32_t, uint32_t >( v, 0 ) );

            for ( ; it != e_.end() && it->first == v; ++it )
            {
                if ( dist_[ pair_[ it->second ] ] == dist_[ v ] + 1 )
                {
                    if ( dfs( pair_[ it->second ] ) )
                    {
                        pair_[ it->second ] = v;
                        pair_[ v ] = it->second;
                        return true;
                    }
                }
            }

            dist_[ v ] = inf;
            return false;
        }
        return true;
    }

public:
    explicit hopcroft_karp_impl( const std::vector< std::pair< VL, VR > >& edges )
        : e_( edges.size() ),
          vl_(),
          vr_(),
          pair_(),
          dist_()
    {

        uint32_t idx = 0;
        uint32_t tot = 0;

        FOR_EACH( it, edges )
        {
            if ( vl_.count( it->first ) == 0 )
            {
                vl_.insert( std::make_pair( it->first, ++tot ) );
            }
        }

        FOR_EACH( it, edges )
        {
            if ( vr_.count( it->second ) == 0 )
            {
                vr_.insert( std::make_pair( it->second, ++tot ) );
            }

            e_[ idx ].first  = vl_[ it->first  ];
            e_[ idx ].second = vr_[ it->second ];
            ++idx;
        }

        std::sort( e_.begin(), e_.end() );

        dist_.resize( vl_.size() + 1 );
        pair_.resize( vl_.size() + vr_.size() + 1 );
        std::fill_n( pair_.begin(), pair_.size(), nil );
    }

    std::size_t execute( std::vector< bool >& res )
    {
        std::size_t matching = 0;
        while ( bfs() )
        {
            for ( uint32_t v = 1; v <= vl_.size(); ++v )
            {
                if ( pair_[ v ] == nil )
                {
                    if ( dfs( v ) )
                    {
                        ++matching;
                    }
                }
            }
        }

        res.resize( e_.size() );
        std::size_t idx = 0;
        FOR_EACH( it, e_ )
        {
            res[ idx ] = ( pair_[ it->first ] == it->second );
            ++idx;
        }
        return matching;
    }

};

template< class VL, class VR >
const uint32_t hopcroft_karp_impl< VL, VR >::inf = 0x7fffffff;

template< class VL, class VR >
const uint32_t hopcroft_karp_impl< VL, VR >::nil = 0;


} // namespace detail

template< class VL, class VR >
std::size_t hopcroft_karp( const std::vector< std::pair< VL, VR > >& edges,
                           std::vector< bool >& res )
{

    detail::hopcroft_karp_impl< VL, VR > hki( edges );

    return hki.execute( res );

}

} // namespace graph
} // namespace zi

#endif

