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

#ifndef ZI_AI_DECISION_TREE_HPP
#define ZI_AI_DECISION_TREE_HPP 1

#include <zi/bits/cstdint.hpp>
#include <zi/bits/shared_ptr.hpp>
#include <zi/utility/for_each.hpp>

#include <zi/ai/detail/information_gain_splitter.hpp>
#include <zi/ai/detail/gini_maximizing_splitter.hpp>
#include <zi/ai/detail/mmdt_splitter.hpp>

#include <vector>
#include <string>
#include <sstream>
#include <boost/lexical_cast.hpp>

namespace zi {
namespace ai {

template< class T, class Splitter >
class decision_tree
{
private:

    class node_base
    {
    public:
        virtual double eval( const T& ) const = 0;
        virtual uint32_t depth() const
        {
            return 0;
        }

        inline double operator()( const T& t ) const
        {
            return eval( t );
        }

        virtual std::string to_string() const = 0;
        virtual void dump_to_file( std::ofstream& ) const = 0;
    };

    class leaf_node: public node_base
    {
    private:
        double probability_;

    public:
        leaf_node( double p )
            : probability_( p )
        {
        }

        leaf_node( std::size_t np, std::size_t nn, double w = 1 )
            : probability_( ( w * np ) / ( w * np + nn ) )
        {
        }

        double eval( const T& ) const
        {
            return probability_;
        }

        std::string to_string() const
        {
            return boost::lexical_cast<std::string>(probability_);
        }

        void dump_to_file( std::ofstream& ofs ) const
        {
            ofs << probability_;
        }
    };

    class interior_node: public node_base
    {
    private:
        typedef typename Splitter::split_fn split_fn;

        split_fn   split_fn_;
        node_base* left_    ;
        node_base* right_   ;
        uint32_t   depth_   ;

    public:
        interior_node( const std::vector< T >& patterns,
                       std::vector< uint32_t >& positives,
                       std::vector< uint32_t >& negatives,
                       const Splitter& splitter,
                       double weight_positive = 1 )
            : split_fn_( splitter.get_split_fn( patterns, positives, negatives, weight_positive ) ),
              left_( 0 ),
              right_( 0 ),
              depth_( 0 )
        {

            std::vector< uint32_t > left_positives;
            std::vector< uint32_t > left_negatives;

            std::vector< uint32_t > right_positives;
            std::vector< uint32_t > right_negatives;

            uint32_t total_left  = 0;
            uint32_t total_right = 0;

            uint32_t total_positive = positives.size();
            uint32_t total_negative = negatives.size();

            FOR_EACH( it, positives )
            {
                if ( split_fn_( patterns[ *it ] ) )
                {
                    left_positives.push_back( *it );
                    ++total_left;
                }
                else
                {
                    right_positives.push_back( *it );
                    ++total_right;
                }
            }

            FOR_EACH( it, negatives )
            {
                if ( split_fn_( patterns[ *it ] ) )
                {
                    left_negatives.push_back( *it );
                    ++total_left;
                }
                else
                {
                    right_negatives.push_back( *it );
                    ++total_right;
                }
            }

            positives.clear();
            negatives.clear();

            if ( total_left == 0 || total_right == 0 )
            {
                left_ = new leaf_node( total_positive, total_negative, weight_positive );
                depth_ = 1;
            }
            else
            {
                left_  = new interior_node( patterns, left_positives , left_negatives ,
                                            splitter, weight_positive );
                right_ = new interior_node( patterns, right_positives, right_negatives,
                                            splitter, weight_positive );
                depth_ = std::max( left_->depth(), right_->depth() ) + 1;
            }

        }

        uint32_t depth() const
        {
            return depth_;
        }


        double eval( const T& t ) const
        {
            if ( right_ )
            {
                if ( split_fn_( t ) )
                {
                    return left_->eval( t );
                }
                else
                {
                    return right_->eval( t );
                }
            }
            else
            {
                return left_->eval( t );
            }
        }

        ~interior_node()
        {
            delete left_;
            if ( right_ )
            {
                delete right_;
            }
        }

        void dump_to_file( std::ofstream& ofs ) const
        {
            if ( split_fn_.is_dummy() || ( !right_) )
            {
                ofs << "v ";
                left_->dump_to_file( ofs );
            }
            else
            {
                ofs << "c " << split_fn_.get_index() << " " << split_fn_.get_threshold() << " ";
                left_->dump_to_file(ofs);
                ofs << " ";
                right_->dump_to_file(ofs);
            }
        }

        std::string to_string() const
        {
            if ( split_fn_.is_dummy() )
            {
                return left_->to_string();
            }
            else
            {
                std::ostringstream iss;
                iss << "( " << boost::lexical_cast<std::string>(split_fn_.get_index()) << " " <<
                    boost::lexical_cast<std::string>(split_fn_.get_threshold()) << " " <<
                    left_->to_string() << " " << right_->to_string() << " )";
                return iss.str();
            }
        }
    };


    shared_ptr< node_base > root_node_;

public:
    explicit decision_tree()
        : root_node_()
    {
    }

    explicit decision_tree( const std::vector< T >& patterns,
                            const std::vector< uint32_t >& positives,
                            const std::vector< uint32_t >& negatives,
                            const Splitter& splitter = Splitter(),
                            double weight_positive = 1 )
        : root_node_()
    {
        create( patterns, positives, negatives, splitter, weight_positive );
    }

    void create( const std::vector< T >& patterns,
                 const std::vector< uint32_t >& positives,
                 const std::vector< uint32_t >& negatives,
                 const Splitter& splitter = Splitter(),
                 double weight_positive = 1 )
    {
        if ( positives.size() == 0 || negatives.size() == 0 )
        {
            root_node_ = shared_ptr< node_base >
                ( new leaf_node( positives.size(), negatives.size(), 1 ));
        }
        else
        {

            std::vector< uint32_t > positives_copy( positives );
            std::vector< uint32_t > negatives_copy( negatives );

            //double weight_positive = 1;
            //static_cast< double >( negatives.size() ) / positives.size();

            root_node_ = shared_ptr< interior_node >
                ( new interior_node( patterns, positives_copy,
                                     negatives_copy, splitter, weight_positive ) );
        }
    }

    double eval( const T& pattern ) const
    {
        double res = root_node_->eval( pattern );
        return res;
    }

    inline double operator()( const T& pattern ) const
    {
        return eval( pattern );
    }

    inline uint32_t depth() const
    {
        return root_node_->depth();
    }

    std::string to_string() const
    {
        return root_node_->to_string();
    }

    void dump_to_file( std::ofstream& ofs ) const
    {
        root_node_->dump_to_file(ofs);
    }


};

} // namespace ai
} // namespace zi

#endif
