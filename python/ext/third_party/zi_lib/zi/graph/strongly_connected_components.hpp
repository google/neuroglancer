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

#ifndef ZI_GRAPH_STRONGLY_CONNECTED_COMPONENTS_HPP
#define ZI_GRAPH_STRONGLY_CONNECTED_COMPONENTS_HPP 1

#include <zi/bits/unordered_map.hpp>
#include <zi/bits/cstdint.hpp>
#include <zi/utility/for_each.hpp>
#include <zi/utility/non_copyable.hpp>

#include <cstddef>
#include <vector>
#include <utility>
#include <algorithm>
#include <limits>

namespace zi {
namespace graph {

namespace detail {

template< class V >
class tarjan_strongly_cc_impl: non_copyable
{
private:
    std::vector< std::pair< uint32_t, uint32_t > > e_;
    unordered_map< V, uint32_t >  vmap_   ;
    std::vector< uint32_t >       indexi_ ;
    std::vector< uint32_t >       comps_  ;
    std::vector< uint32_t >       lowlink_;
    std::vector< uint32_t >       stack_  ;
    uint32_t                      index_  ;
    uint32_t                      comp_   ;

    static const uint32_t inf;

    void tarjan( uint32_t v )
    {
        indexi_[ v ] = lowlink_[ v ] = index_++;
        stack_.push_back( v );
        comps_[ v ] = inf;
        std::vector< std::pair< uint32_t, uint32_t > >::iterator it
            = lower_bound( e_.begin(), e_.end(),
                           std::pair< uint32_t, uint32_t >( v, 0 ) );

        for ( ; it != e_.end() && it->first == v; ++it )
        {
            if ( indexi_[ it->second ] == inf )
            {
                tarjan( it->second );
                lowlink_[ v ] = std::min( lowlink_[ v ], lowlink_[ it->second ] );
            }
            else
            {
                if ( comps_[ it->second ] == inf )
                {
                    lowlink_[ v ] = std::min( lowlink_[ v ], indexi_[ it->second ] );
                }
            }
        }

        if ( indexi_[ v ] == lowlink_[ v ] )
        {
            uint32_t vp;
            do
            {
                vp = stack_.back();
                stack_.pop_back();
                comps_[ vp ] = comp_;
            } while ( vp != v );
            ++comp_;
        }
    }

public:
    explicit tarjan_strongly_cc_impl( const std::vector< std::pair< V, V > >& edges )
        : e_( edges.size() ),
          vmap_(),
          indexi_(),
          comps_(),
          lowlink_(),
          stack_(),
          index_( 0 ),
          comp_( 0 )
    {

        uint32_t idx = 0;
        uint32_t tot = 0;

        FOR_EACH( it, edges )
        {
            if ( vmap_.count( it->first ) == 0 )
            {
                vmap_.insert( std::make_pair( it->first, tot++ ) );
            }

            if ( vmap_.count( it->second ) == 0 )
            {
                vmap_.insert( std::make_pair( it->second, tot++ ) );
            }

            e_[ idx ].first  = vmap_[ it->first  ];
            e_[ idx ].second = vmap_[ it->second ];

            ++idx;
        }

        std::sort( e_.begin(), e_.end() );

        indexi_.resize( tot );
        lowlink_.resize( tot );
        comps_.resize( tot );
        std::fill_n( indexi_.begin(), indexi_.size(), inf );
        std::fill_n( comps_.begin(), comps_.size(), 0 );
    }

    std::size_t execute( std::vector< std::pair< V, uint32_t > >& res )
    {
        for ( uint32_t i = 0; i < indexi_.size(); ++i )
        {
            if ( indexi_[ i ] == inf )
            {
                tarjan( i );
            }
        }

        res.clear();

        FOR_EACH( it, vmap_ )
        {
            res.push_back( std::make_pair( it->first, comps_[ it->second ] ) );
        }

        return comp_;
    }

};

template< class V >
const uint32_t tarjan_strongly_cc_impl< V >::inf = 0x7fffffff;

} // namespace detail

template< class V >
std::size_t tarjan_strongly_cc( const std::vector< std::pair< V, V > >& edges,
                                std::vector< std::pair< V, uint32_t > >& res )
{

    detail::tarjan_strongly_cc_impl< V > tscc( edges );

    return tscc.execute( res );

}

} // namespace graph
} // namespace matching

#endif
