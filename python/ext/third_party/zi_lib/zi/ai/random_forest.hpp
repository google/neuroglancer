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

#ifndef ZI_AI_RANDOM_FOREST_HPP
#define ZI_AI_RANDOM_FOREST_HPP 1

#include <zi/ai/decision_tree.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/thread.hpp>
#include <zi/concurrency/task_manager.hpp>
#include <zi/bits/bind.hpp>
#include <zi/utility/address_of.hpp>

#include <cstddef>
#include <cmath>
#include <iostream>
#include <sstream>
#include <fstream>

namespace zi {
namespace ai {

template< class T, class Splitter >
class random_forest
{
private:
    std::vector< decision_tree< T, Splitter > > trees_;
    zi::mutex lock_;

    typedef random_forest< T, Splitter > this_random_forest_type;

public:
    explicit random_forest()
        : trees_(),
          lock_()
    {
    }

    explicit random_forest( uint32_t n,
                            const std::vector< T >& patterns,
                            const std::vector< uint32_t >& positives,
                            const std::vector< uint32_t >& negatives,
                            const Splitter& splitter = Splitter() )
        : trees_(),
          lock_()
    {
        create( n, patterns, positives, negatives, splitter );
    }

    void create_single_tree( const std::vector< T >* patterns,
                             const std::vector< uint32_t >* positives,
                             const std::vector< uint32_t >* negatives,
                             const Splitter* splitter )
    {
        uint32_t total = positives->size() + negatives->size();

        std::vector< uint32_t > bag_positives;
        std::vector< uint32_t > bag_negatives;

        for ( uint32_t j = 0; j < total; ++j )
        {
            if ( std::rand() % 2 )
            {
                uint32_t rnd = static_cast< uint32_t >( std::rand() % positives->size() );
                bag_positives.push_back( positives->operator[]( rnd ) );
            }
            else
            {
                uint32_t rnd = static_cast< uint32_t >( std::rand() % negatives->size() );
                bag_negatives.push_back( negatives->operator[]( rnd ) );
            }
        }/*


        for ( uint32_t j = 0; j < total; ++j )
        {
            uint32_t rnd = static_cast< uint32_t >( std::rand() % total );

            if ( rnd < positives->size() )
            {
                //j += 5;
                bag_positives.push_back( positives->operator[]( rnd ) );
            }
            else
            {
                bag_negatives.push_back( negatives->operator[]( rnd - positives->size() ) );
            }
        }

/*
        std::cout << "Current sizes: " << bag_positives.size()
                  << ", " << bag_negatives.size() << "\n" << std::flush;

        // balance the data
        while ( bag_negatives.size() > bag_positives.size() && bag_negatives.size() > 0 )
        {
            std::swap( bag_negatives[ std::rand() % bag_negatives.size() ], bag_negatives.back() );
            bag_negatives.pop_back();
        }

        while ( bag_negatives.size() < bag_positives.size() && bag_positives.size() > 0 )
        {
            std::swap( bag_positives[ std::rand() % bag_positives.size() ], bag_positives.back() );
            bag_positives.pop_back();
        }
*/
        std::cout << "Actual sizes: " << bag_positives.size()
                  << ", " << bag_negatives.size() << "\n" << std::flush;


        decision_tree< T, Splitter > new_tree( *patterns, bag_positives,
                                               bag_negatives, splitter->next(), 1 );//6.233 );

        {
            zi::mutex::guard g( lock_ );
            trees_.push_back( new_tree );
            std::cout << "Generated " << trees_.size() << " th tree\n";
            std::cout << "  >> depth: " << new_tree.depth() << "\n" << std::flush;

        }
    }

    void create( uint32_t n,
                 const std::vector< T >& patterns,
                 const std::vector< uint32_t >& positives,
                 const std::vector< uint32_t >& negatives,
                 const Splitter& splitter = Splitter() )
    {
        zi::task_manager::simple tm( 32 );

        for ( uint32_t i = 0; i < n; ++i )
        {
            tm.push_back( zi::run_fn
                          ( zi::bind
                            ( &this_random_forest_type::create_single_tree, this,
                              &patterns, &positives, &negatives, &splitter ) ));
        }

        tm.start();
        tm.join();

        std::cout << "\n";

    }

    double eval( const T& pattern ) const
    {
        if ( trees_.size() )
        {
            double res = 0;

            FOR_EACH( it, trees_ )
            {
                res += it->eval( pattern );
            }

            return res / trees_.size();
        }

        return -1;
    }

    double operator()( const T& pattern ) const
    {
        return eval( pattern );
    }

    std::string to_string() const
    {
        std::ostringstream iss;
        if ( trees_.size() )
        {
            FOR_EACH( it, trees_ )
            {
                iss << it->to_string() << "\n";
            }
        }
        return iss.str();
    }

    void dump() const
    {
        if ( trees_.size() )
        {
            FOR_EACH( it, trees_ )
            {
                std::cout << it->to_string() << "\n";
            }
        }
    }

    void dump_to_file( std::ofstream& ofs ) const
    {
        if ( trees_.size() )
        {
            FOR_EACH( it, trees_ )
            {
                it->dump_to_file( ofs );
                ofs << "\n";
            }
        }
    }

};

} // namespace ai
} // namespace zi

#endif
