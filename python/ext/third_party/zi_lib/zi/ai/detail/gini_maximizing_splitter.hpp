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

#ifndef ZI_AI_DETAIL_GINI_MAXIMIZING_SPLITTER_HPP
#define ZI_AI_DETAIL_GINI_MAXIMIZING_SPLITTER_HPP 1

#include <vector>
#include <cstddef>

namespace zi {
namespace ai {
namespace splitter {

template< class T, std::size_t Sub >
class gini_maximizing
{
public:
    class split_fn
    {
    private:
        uint32_t index_          ;
        T        threshold_      ;
        bool     all_same_       ;

    public:
        explicit split_fn( uint32_t index, T threshold,
                           bool all_same = false )
            : index_( index ),
              threshold_( threshold ),
              all_same_( all_same )
        {
        }

        bool operator()( const std::vector< T >& p ) const
        {
            if ( all_same_ )
            {
                return true;
            }
            else
            {
                return p[ index_ ] < threshold_;
            }
        }

        uint32_t get_index() const
        {
            return index_;
        }

        T get_threshold() const
        {
            return threshold_;
        }

        bool is_dummy() const
        {
            return all_same_;
        }
    };

    split_fn get_split_fn( const std::vector< std::vector< T > >& patterns,
                           const std::vector< uint32_t >& positives,
                           const std::vector< uint32_t >& negatives,
                           double weight_positive = 1 ) const
    {

        if ( positives.size() == 0 || negatives.size() == 0 )
        {
            return split_fn( 0, 0, true );
        }

        uint32_t len = patterns[ 0 ].size();
        std::vector< uint32_t > all( len );
        for ( uint32_t i = 0; i < len; ++i )
        {
            all[ i ] = i;
        }
        std::random_shuffle( all.begin(), all.end() );

        all.resize( Sub );

        double   p_pos = static_cast< double >( weight_positive * positives.size() ) /
            ( weight_positive * positives.size() + negatives.size() );

        //double   original_gini = p_pos * ( 1 - p_pos ) * 2;

        T        best_threshold = patterns[ positives[ 0 ] ][ all[ 0 ] ];
        double   best_inf_gain  = 1000;
        uint32_t best_idx       = all[ 0 ];

        for ( uint32_t i = 0; i < Sub; ++i )
        {
            std::vector< T > curr_positives( positives.size() );
            std::vector< T > curr_negatives( negatives.size() );

            uint32_t idx = 0;
            FOR_EACH( it, positives )
            {
                curr_positives[ idx++ ] = patterns[ (*it) ][ all[ i ] ];
            }

            std::sort( curr_positives.begin(), curr_positives.end() );

            idx = 0;
            FOR_EACH( it, negatives )
            {
                curr_negatives[ idx++ ] = patterns[ (*it) ][ all[ i ] ];
            }

            std::sort( curr_negatives.begin(), curr_negatives.end() );

            uint32_t positives_total = positives.size();
            uint32_t negatives_total = negatives.size();
            double   total = weight_positive * positives_total + negatives_total;

            T curr_threshold = std::min( curr_positives[ 0 ], curr_negatives[ 0 ] );

            for ( uint32_t p_idx = 0, n_idx = 0;
                  p_idx < curr_positives.size() || n_idx < curr_negatives.size(); )
            {
                T new_threshold = 0 ; //std::min( ( n_idx < curr_negatives.size() ) ?
                //    curr_negatives[ n_idx ] : curr_positives[ p_idx ],
                //                          ( p_idx < curr_positives.size() ) ?
                //                          curr_positives[ p_idx ] : curr_negatives[ n_idx ] );

                if ( p_idx == curr_positives.size() )
                {
                    new_threshold = curr_negatives[ n_idx ];
                }
                else
                {
                    if ( n_idx == curr_negatives.size() )
                    {
                        new_threshold = curr_positives[ p_idx ];
                    }
                    else
                    {
                        if ( curr_negatives[ n_idx ] < curr_positives[ p_idx ] )
                        {
                            new_threshold = curr_negatives[ n_idx ];
                        }
                        else
                        {
                            new_threshold = curr_positives[ p_idx ];
                        }
                    }
                }

                if ( new_threshold != curr_threshold )
                {
                    curr_threshold = new_threshold;

                    double p_pos_l = static_cast< double >( n_idx ) /
                        ( weight_positive * p_idx + n_idx );
                    double p_pos_r = static_cast< double >( negatives_total - n_idx ) /
                        ( total - weight_positive * p_idx - n_idx );

                    double curr_gini =
                        p_pos_l * ( 1 - p_pos_l ) * 2 * ( static_cast< double >( weight_positive * p_idx + n_idx ) / total ) +
                        p_pos_r * ( 1 - p_pos_r ) * 2 * ( static_cast< double >( total - weight_positive * p_idx - n_idx ) / total );

                    double curr_inf_gain = curr_gini;

                    if ( curr_inf_gain < best_inf_gain )
                    {
                        best_inf_gain  = curr_inf_gain;
                        best_threshold = new_threshold;
                        best_idx       = all[ i ];
                    }
                }

                if ( p_idx == curr_positives.size() )
                {
                    ++n_idx;
                }
                else
                {
                    if ( n_idx == curr_negatives.size() )
                    {
                        ++p_idx;
                    }
                    else
                    {
                        if ( curr_negatives[ n_idx ] < curr_positives[ p_idx ] )
                        {
                            ++n_idx;
                        }
                        else
                        {
                            ++p_idx;
                        }
                    }
                }



            }

        }

        return split_fn( best_idx, best_threshold );

    }

    gini_maximizing< T, Sub > next() const
    {
        return *this;
    }

};


} // namespace splitter
} // namespace ai
} // namespace zi

#endif
