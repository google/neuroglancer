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

//
// http://en.wikipedia.org/wiki/Jacobi_eigenvalue_algorithm
//

#ifndef ZI_VL_DETAIL_JACOBI_HPP
#define ZI_VL_DETAIL_JACOBI_HPP 1

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/for_each.hpp>
#include <zi/vl/mat.hpp>
#include <zi/bits/unordered_set.hpp>
#include <zi/bits/hash.hpp>
#include <zi/heap/binary_heap.hpp>

#include <vector>
#include <algorithm>
#include <iostream>

namespace zi {
namespace vl {
namespace detail {

template< class T, std::size_t N >
class jacobi_solver: non_copyable
{
private:
    ZI_STATIC_ASSERT( N > 0 , zero_length_jacobi );
    ZI_STATIC_ASSERT( is_floating_point< T >::value, non_float_jacobi );

    unordered_set< std::size_t > active_;


    struct heap_element
    {
        std::size_t        row_  ;
        std::size_t        col_  ;
        T                  value_;
        std::size_t        id_   ;

        heap_element( std::size_t r, std::size_t c, const T& v )
            : row_( r ), col_( c ), value_( v ), id_( r )
        {
        }

        std::size_t id() const
        {
            return id_;
        }

        std::size_t row() const
        {
            return row_;
        }

        std::size_t column() const
        {
            return col_;
        }

        const T& value() const
        {
            return value_;
        }

    };

    typedef binary_heap<
        heap_element,
        zi::heap::hashed_index<
            zi::heap::member_variable<
                heap_element,
                std::size_t,
                &heap_element::id_
            >
        >,

        zi::heap::value<
            zi::heap::member_variable<
                heap_element,
                T,
                &heap_element::value_
            >,
            std::greater< T >
        >
    > heap_type;

private:
    mat< T, N >& S;
    vec< T, N >& e;
    mat< T, N >& E;

    std::size_t                         total_converged_ ;
    std::vector< bool >                 has_converged_   ;
    std::size_t                         iteration_number_;
    heap_type                           heap_            ;

    static const std::size_t no_index = 0xffffffff;

private:

    bool update_index( std::size_t r )
    {
        std::size_t cur_idx = 0;
        T           cur_max = 0;

        for ( std::size_t i = r + 1; i < N; ++i )
        {
            T val = std::abs( S.at( r, i ) );
            if ( val > cur_max )
            {
                cur_max = val;
                cur_idx = i;
            }
        }

        if ( cur_idx > 0 )
        {
            heap_.insert( heap_element( r, cur_idx, cur_max ) );
            return true;
        }

        return false;
    }

    void rotate( T& p1, T& p2, T sine, T cosine )
    {
        T s1 = cosine * p1 - sine   * p2;
        T s2 = sine   * p1 + cosine * p2;
        p1 = s1;
        p2 = s2;
    }

public:
    explicit jacobi_solver( mat< T, N >& _S, vec< T, N >& _e, mat< T, N >& _E )
        : S( _S ), e( _e ), E( _E ), total_converged_( 0 ),
          has_converged_( N ), iteration_number_( 0 ), heap_()
    {
    }

    void decompose()
    {
        E = mat< T, N >::eye;
        e = get_diagonal( S );
        total_converged_ = 0;

        has_converged_.resize( N );
        std::fill_n( has_converged_.begin(), N, false );

        for ( std::size_t i = 0; i < N; ++i )
        {
            update_index( i );
        }

        iteration_number_ = 0;

        while ( heap_.size() > 0 && total_converged_ < N )
        {

            ++iteration_number_;

            std::size_t rowi = heap_.top().row();
            std::size_t coli = heap_.top().column();

            if ( rowi < 0 || rowi >= N || coli < 0 || coli >= N )
                 return ;

            T y = 0.5 * ( e.at( coli ) - e.at( rowi ) );
            T p = S.at( rowi, coli );
            T psqr = p * p;

            T t = std::abs( y ) + std::sqrt( psqr + y*y );
            T s = std::sqrt( psqr + t*t );
            T c = t / s;
            s = p / s;
            t = psqr / t;

            if ( y < 0 )
            {
                s = -s;
                t = -t;
            }

            S.at( rowi, coli ) = 0;

            heap_.pop();

            if ( std::fabs( t ) > std::numeric_limits< T >::epsilon() )
            {
                e.at( rowi ) -= t;
                e.at( coli ) += t;

                if ( has_converged_[ rowi ] )
                {
                    has_converged_[ rowi ] = false;
                    --total_converged_;
                }

                if ( has_converged_[ coli ] )
                {
                    has_converged_[ coli ] = false;
                    --total_converged_;
                }

            }
            else
            {
                if ( !has_converged_[ rowi ] )
                {
                    has_converged_[ rowi ] = true;
                    ++total_converged_;
                }

                if ( !has_converged_[ coli ] )
                {
                    has_converged_[ coli ] = true;
                    ++total_converged_;
                }
            }

            {
                std::size_t i = 0;

                for ( i = 0; i < rowi; ++i )
                {
                    rotate( S.at( i, rowi ), S.at( i, coli ), s, c );
                }

                for ( i = rowi + 1; i < coli; ++i )
                {
                    rotate( S.at( rowi, i ), S.at( i, coli ), s, c );
                }

                for ( i = coli + 1 ; i < N; ++i )
                {
                    rotate( S.at( rowi, i ), S.at( coli, i ), s, c );
                }

            }

            for ( std::size_t i = 0; i < N; ++i )
            {
                rotate( E.at( rowi, i ), E.at( coli, i ), s, c );
            }

            update_index( rowi );
            update_index( coli );

        }

        for ( std::size_t i = 0; i < N-1; ++i )
        {
            for ( std::size_t j = i+1; j < N; ++j )
            {
                S.at( i, j ) = S.at( j, i );
            }
        }
    }

};

} // namespace detail

template< class T, std::size_t N >
inline
void
jacobi_svd( mat< T, N >& S, vec< T, N >& e, mat< T, N >& E,
            typename enable_if< is_floating_point< T >::value >::type* = 0 )
{
    detail::jacobi_solver< T, N > jcb( S, e, E );
    jcb.decompose();

}

} // namespace vl
} // namespace zi

#endif

