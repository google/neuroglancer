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

#ifndef ZI_MESH_QUADRATIC_SIMPLIFIER_HPP
#define ZI_MESH_QUADRATIC_SIMPLIFIER_HPP 1

#include <zi/bits/shared_ptr.hpp>
#include <zi/bits/unordered_set.hpp>
#include <zi/bits/unordered_map.hpp>
#include <zi/utility/static_assert.hpp>

#include <zi/heap/binary_heap.hpp>
#include <zi/mesh/tri_list.hpp>
#include <zi/mesh/tri_mesh.hpp>
#include <zi/mesh/tri_stripper.hpp>
#include <zi/mesh/detail/quadratic.hpp>
#include <zi/mesh/detail/qmetric.hpp>

#include <zi/vl/vec.hpp>
#include <zi/vl/quat.hpp>

#include <vector>
#include <iostream>
#include <functional>

namespace zi {
namespace mesh {

template< class Float >
class simplifier: non_copyable
{
private:
    ZI_STATIC_ASSERT( is_floating_point< Float >::value, non_floating_point_mesh_simplifier );

    typedef vl::vec< Float, 3 >        coord_t     ;
    typedef detail::quadratic< Float > quadratic_t ;

    std::size_t                 size_     ;
    mesh::tri_mesh              mesh_     ;
    std::vector< coord_t >      points_   ;
    std::vector< coord_t >      normals_  ;

    std::vector< quadratic_t >  quadratic_;
    unordered_set< uint64_t >   invalid_  ;

    struct heap_entry
    {
        uint64_t                  edge_   ;
        Float                     value_  ;
        const vl::vec< Float, 3 > optimal_;

        Float value() const
        {
            return value_;
        }

        heap_entry()
        {
        }

        heap_entry( const uint64_t e, const Float v, const vl::vec< Float, 3 >& p )
            : edge_( e ), value_( v ), optimal_( p )
        {
        }

        uint32_t v0() const
        {
            return detail::edge_source( edge_ );
        }

        uint32_t v1() const
        {
            return detail::edge_sink( edge_ );
        }

        uint32_t source() const
        {
            return detail::edge_source( edge_ );
        }

        uint32_t sink() const
        {
            return detail::edge_sink( edge_ );
        }

    };

    friend struct heap_entry;

    typedef binary_heap<
        heap_entry,
        zi::heap::hashed_index<
            zi::heap::member_variable<
                heap_entry,
                uint64_t,
                &heap_entry::edge_
            >
        >,

        zi::heap::value<
            zi::heap::member_variable<
                heap_entry,
                Float,
                &heap_entry::value_
            >,
            std::less< Float >
        >
    > heap_type;

    heap_type heap_;



private:
    bool check_valid_edge( const uint64_t e ) const
    {
        return e && mesh_.valid_edge( e );
    }

    bool check_compactness( const uint64_t e, const vl::vec< Float, 3 >& p ) const
    {
        const Float min_compactness = 0.05;

        const uint32_t v0 = detail::edge_source( e );
        const uint32_t v1 = detail::edge_sink( e );

        const uint64_t einv = detail::make_edge( v1, v0 );

        const uint32_t tr = mesh_.across_edge( e );
        const uint32_t bl = mesh_.across_edge( einv );

        for ( uint32_t v = tr; v != bl; )
        {
            const uint32_t vn = mesh_.across_edge( v0, v );
            vl::vec< Float, 3 > c1 = cross( points_[ v ] - p, points_[ vn ] - p );
            Float r = len( c1 ) * 0.5 * 6.928203230275509L
                / ( sqrlen( p - points_[ v ] ) +
                    sqrlen( points_[ v ] - points_[ vn ] ) +
                    sqrlen( points_[ vn ] - p ) );

            if ( r < min_compactness )
            {
                return false;
            }
            v = vn;
        }

        for ( uint32_t v = bl; v != tr; )
        {
            const uint32_t vn = mesh_.across_edge( v1, v );
            vl::vec< Float, 3 >  c1 = cross( points_[ v ] - p, points_[ vn ] - p );
            Float r = len( c1 ) * 0.5 * 6.928203230275509L
                / ( sqrlen( p - points_[ v ] ) +
                    sqrlen( points_[ v ] - points_[ vn ] ) +
                    sqrlen( points_[ vn ] - p ) );

            if ( r < min_compactness )
            {
                return false;
            }
            v = vn;
        }

        return true;
    }

    bool check_inversion( const uint64_t e, const vl::vec< Float, 3 >& p )
    {
        //if ( invalid_.count( e ) )
        //{
        //return false;
        //}

        const uint32_t max_degree = 15;
        const Float    min_angle  = 0.001;

        const uint32_t v0 = detail::edge_source( e );
        const uint32_t v1 = detail::edge_sink( e );

        const uint64_t einv = detail::make_edge( v1, v0 );

        const uint32_t tr = mesh_.across_edge( e );
        const uint32_t bl = mesh_.across_edge( einv );

        uint32_t degree = 0;

        for ( uint32_t v = tr; v != bl; )
        {
            const uint32_t vn = mesh_.across_edge( v0, v );
            vl::vec< Float, 3 > a = points_[ vn ] - points_[ v ];

            if ( dot( cross( a, points_[ v0 ] - points_[ v ] ),
                      cross( a, p - points_[ v ] )) < min_angle )
            {
                return false;
            }

            v = vn;
            ++degree;
        }

        for ( uint32_t v = bl; v != tr; )
        {
            const uint32_t vn = mesh_.across_edge( v1, v );

            vl::vec< Float, 3 > a = points_[ vn ] - points_[ v ];

            if ( dot( cross( a, points_[ v1 ] - points_[ v ] ),
                      cross( a, p - points_[ v ] )) < min_angle )
            {
                return false;
            }

            v = vn;
            ++degree;
        }

        return degree < max_degree;
    }

    bool check_topology( const uint64_t e )
    {

        if ( invalid_.count( e ) )
        {
            return false;
        }

        const uint32_t v0 = detail::edge_source( e );
        const uint32_t v1 = detail::edge_sink( e );

        const uint32_t tr = mesh_.across_edge( e );
        const uint32_t bl = mesh_.across_edge( v1, v0 );

        if ( bl == tr )
        {
            return false;
        }

        for ( uint32_t v = mesh_.across_edge( v0, tr );
              v != bl;
              v = mesh_.across_edge( v0, v ) )
        {
            if ( mesh_.has_edge( v1, v ) )
            {
                invalid_.insert( e );
                return false;
            }
        }

        return true;
    }

public:

    explicit simplifier()
        : size_( 0 ),
          mesh_(),
          points_(),
          normals_(),
          quadratic_( 0 ),
          invalid_(),
          heap_()
    {
    }

    explicit simplifier( std::size_t s )
        : size_( s ),
          mesh_( s ),
          points_( s ),
          normals_( s ),
          quadratic_( s ),
          invalid_(),
          heap_()
    {
    }

/*
    explicit simplifier( mesh::tri_mesh& m )
        : size_( m.size() ),
          mesh_cnt_(),
          points_cnt_( size_ ),
          normals_cnt_( size_ ),
          mesh_( m ),
          points_( points_cnt_ ),
          normals_( normals_cnt_ ),
          quadratic_( size_ ),
          invalid_(),
          heap_()
    {
    }
*/

/*
    explicit simplifier( mesh::tri_mesh& m, std::vector< coord_t >& v )
        : size_( m.size() ),
          mesh_cnt_(),
          points_cnt_(),
          normals_cnt_( size_ ),
          mesh_( m ),
          points_( v ),
          normals_( normals_cnt_ ),
          quadratic_( size_ ),
          invalid_(),
          heap_()
    {
        v.resize( m.size() );
    }

    explicit simplifier( mesh::tri_mesh& m,
                         std::vector< coord_t >& v,
                         std::vector< coord_t >& n )
        : size_( m.size() ),
          mesh_cnt_(),
          points_cnt_(),
          normals_cnt_(),
          mesh_( m ),
          points_( v ),
          normals_( n ),
          quadratic_( size_ ),
          invalid_(),
          heap_()
    {
        v.resize( m.size() );
        n.resize( m.size() );
    }

*/
    vl::vec< Float, 3 >& point( std::size_t idx )
    {
        ZI_ASSERT( idx < size_ );
        return points_[ idx ];
    }

    const vl::vec< Float, 3 >& point( std::size_t idx ) const
    {
        ZI_ASSERT( idx < size_ );
        return points_[ idx ];
    }

    detail::quadratic< Float >& quadratic( std::size_t idx )
    {
        ZI_ASSERT( idx < size_ );
        return quadratic_[ idx ];
    }

    const detail::quadratic< Float >& quadratic( std::size_t idx ) const
    {
        ZI_ASSERT( idx < size_ );
        return quadratic_[ idx ];
    }

    vl::vec< Float, 3 >& normal( std::size_t idx )
    {
        ZI_ASSERT( idx < size_ );
        return normals_[ idx ];
    }

    const vl::vec< Float, 3 >& normal( std::size_t idx ) const
    {
        ZI_ASSERT( idx < size_ );
        return normals_[ idx ];
    }

    void resize( std::size_t s )
    {
        size_ = s;
        heap_.clear();
        invalid_.clear();

        mesh_.resize( s );
        points_.resize( s );
        normals_.resize( s );
        quadratic_.resize( s );
    }

    void clear( std::size_t s = 0 )
    {
        if ( s != 0 )
        {
            size_ = s;
        }
        resize( size_ );
    }

    uint32_t add_face( const uint32_t x, const uint32_t y, const uint32_t z )
    {
        return mesh_.add_face( x, y, z );
    }

    void prepare(bool init_normals = true)
    {
        //mesh_.check_rep();
        generate_quadratics();
        if ( init_normals )
        {
            generate_normals();
        }
        init_heap();
        //std::cout << "HS: " << heap_size() << "\n";
        //std::cout << "FC: " << mesh_.face_count() << "\n";
    }

    std::size_t heap_size() const
    {
        return heap_.size();
    }

    std::size_t round()
    {
        iterate();
        return heap_.size();
    }

    std::size_t optimize( std::size_t target_faces,
                          Float max_error,
                          Float min_error = std::numeric_limits< Float >::epsilon() * 25 )
    {

        //double no_faces = static_cast< double >( mesh_.face_count() );

        std::size_t bad = 0;
        while ( heap_.size() )
        {
            if ( ( ( mesh_.face_count() <= target_faces ) &&
                   ( heap_.top().value_ >= min_error ) ) ||
                 ( heap_.top().value_ > max_error ) )
            {
                break;
            }
            if ( !iterate() )
            {
                ++bad;
            }
        }

        //generate_normals();

        invalid_.clear();
        // std::cout << "Face ratio: " << ( static_cast< double >( mesh_.face_count() ) / target_faces ) << "\n";
        // std::cout << "Next error: " << this->min_error() << "\n";
        // std::cout << "Total Face: " << mesh_.face_count() << "\n";
        // std::cout << "Heap Size : " << heap_.size() << "\n";
        // std::cout << "Bad  Size : " << bad << "\n";
        return mesh_.face_count();
    }

    std::size_t face_count() const
    {
        return mesh_.face_count();
    }

    std::size_t edge_count() const
    {
        return mesh_.edge_count();
    }

    std::size_t vertex_count() const
    {
        return size_;
    }

    Float min_error() const
    {
        if ( heap_.size() )
        {
            return heap_.top().value_;
        }

        return 0;
    }

    detail::tri_mesh_face_container& faces()
    {
        return mesh_.faces;
    }

    std::size_t stripify( std::vector< uint32_t >& vertices,
                          std::vector< uint32_t >& strip_begins,
                          std::vector< uint32_t >& strip_lengths ) const
    {
        tri_stripper_impl stripper( mesh_ );
        return stripper.execute( vertices, strip_begins, strip_lengths );
    }

    std::size_t stripify( std::vector< vl::vec< Float, 3 > >& points,
                          std::vector< vl::vec< Float, 3 > >& normals,
                          std::vector< uint32_t >& indices,
                          std::vector< uint32_t >& strip_begins,
                          std::vector< uint32_t >& strip_lengths ) const
    {
        tri_stripper_impl stripper( mesh_ );
        std::size_t res = stripper.execute( indices, strip_begins, strip_lengths );

        unordered_map< uint32_t, uint32_t > reduction;
        uint32_t max_idx = 0;

        for ( std::size_t i = 0; i < indices.size(); ++i )
        {
            if ( reduction.count( indices[ i ] ) == 0 )
            {
                reduction.insert( std::make_pair( indices[ i ], max_idx ) );
                points.push_back( points_[ indices[ i ] ] );
                normals.push_back( normals_[ indices[ i ] ] );
                ++max_idx;
            }
            indices[ i ] = reduction[ indices[ i ] ];
        }

        return res;
    }


public:

#define ZI_MESH_SIMPLIFIER_GET_FACES_HELPER_FUNCTION(__what)       \
    if ( reduction[__what] & 0x8000000 )                           \
    {                                                              \
        reduction[__what] = max_idx;                               \
        indices.push_back(__what);                                 \
        __what = max_idx++;                                        \
    }                                                              \
    else                                                           \
    {                                                              \
        __what = reduction[__what];                                \
    }                                                              \
    static_cast<void>(0)

    std::size_t get_faces( std::vector< vl::vec< Float, 3 > >& points,
                           std::vector< vl::vec< Float, 3 > >& normals,
                           std::vector< vl::vec< uint32_t, 3 > >& faces )
    {
        mesh_.get_faces( faces );

        std::vector< uint32_t > reduction(points_.size(), 0x8000000);
        std::vector< uint32_t > indices;
        indices.reserve(faces.size()*3);

        uint32_t max_idx = 0;

        for ( std::size_t i = 0; i < faces.size(); ++i )
        {
            ZI_MESH_SIMPLIFIER_GET_FACES_HELPER_FUNCTION(faces[i][0]);
            ZI_MESH_SIMPLIFIER_GET_FACES_HELPER_FUNCTION(faces[i][1]);
            ZI_MESH_SIMPLIFIER_GET_FACES_HELPER_FUNCTION(faces[i][2]);
        }

        points.resize(indices.size());
        normals.resize(indices.size());

        for ( std::size_t i = 0; i < indices.size(); ++i )
        {
            //std::cout << indices[i] << " ---> " << i << '\n';
            points[i]  = points_[indices[i]];
            normals[i] = normals_[indices[i]];
        }

        return faces.size();
    }

#undef ZI_MESH_SIMPLIFIER_GET_FACES_HELPER_FUNCTION

private:

    bool check_valid( const uint64_t e, const vl::vec< Float, 3 >& p ) const
    {
        // todo: better inverion check
        //return ( check_topology( e, p ) && ( check_inversion( e, p ) < 0.1 ) );
        return false;
    }

    bool iterate()
    {
        ZI_ASSERT( heap_.size() );

        heap_entry e( heap_.top() );
        heap_.pop();

        const uint32_t v0 = detail::edge_source( e.edge_ );
        const uint32_t v1 = detail::edge_sink  ( e.edge_ );

        if ( !check_valid_edge( e.edge_ ) )
        {
            //std::cout << "valid_edge\n";
            return false;
        }

        if ( !check_topology( e.edge_ ) )
        {
            //std::cout << "topology\n";
            return false;
        }

        if ( !check_inversion( e.edge_, e.optimal_ ) ) // todo: better
        {
            //std::cout << "inversion\n";
            return false;
        }

        if ( !check_compactness( e.edge_, e.optimal_ ) )
        {
            //std::cout << "compactness\n";
            return false;
        }

        // erase old ones
        for ( uint32_t v = mesh_.across_edge( v0, v1 );
              v != v1;
              v = mesh_.across_edge( v0, v ) )
        {
            uint64_t eind = ( v0 < v ) ?
                detail::make_edge( v0, v ) :
                detail::make_edge( v, v0 );
            heap_.erase_key( eind );
        }

        for ( uint32_t v = mesh_.across_edge( v1, v0 );
              v != v0;
              v = mesh_.across_edge( v1, v ) )
        {
            uint64_t eind = ( v1 < v ) ?
                detail::make_edge( v1, v ) :
                detail::make_edge( v, v1 );
            heap_.erase_key( eind );
        }

        uint32_t v = mesh_.collapse_edge( v0, v1 );

        //Float errv0 = std::sqrt( quadratic_[ v0 ].evaluate( e.optimal_ ) );
        //Float errv1 = std::sqrt( quadratic_[ v1 ].evaluate( e.optimal_ ) );

        //static const Float sqrt_epsilon =
        //std::sqrt( std::numeric_limits< Float >::epsilon() );


/*

        Float errv0 = quadratic_[ v0 ].evaluate( e.optimal_ );
        Float errv1 = quadratic_[ v1 ].evaluate( e.optimal_ );

        static const Float sqrt_epsilon =
            std::numeric_limits< Float >::epsilon();

        Float err = errv0 + errv1;

        if ( ( errv0 < sqrt_epsilon ) &&
             ( errv1 < sqrt_epsilon ) )
        {
            normals_[ v ] = norm( normals_[ v1 ] + normals_[ v0 ] );
        }
        else
        {
            if ( errv0 < sqrt_epsilon )
            {
                normals_[ v ] = normals_[ v0 ];
            }
            else
            {
                if ( errv1 < sqrt_epsilon )
                {
                    normals_[ v ] = normals_[ v1 ];
                }
                else
                {
                    errv1 /= err;
                    normals_[ v ] = norm( slerp( normals_[ v1 ], normals_[ v0 ], errv1 ) );
                }
            }
            //normals_[ v ] = normals_[ v0 ] + normals_[ v1 ];
        }

*/

        //vl::vec< Float, 3 > vx = points_[ v1 ];
        //vx += points_[ v1 ] * ( dot( points_[ v0 ] - points_[ v1 ],
        //                           norm( normals_[ v1 ] ) ) );

        //std::cout << dot( points_[ v1 ] - vx, normals_[ v0

        normals_[ v ] = normals_[ v0 ] + normals_[ v1 ];

        points_[ v ] = e.optimal_;

        quadratic_[ v ] += ( v == v0 ) ? quadratic_[ v1 ] : quadratic_[ v0 ];

        ZI_ASSERT( mesh_.valid_vertex( v ) );

        uint32_t vlast = detail::edge_sink( mesh_.vertex_edge( v ) );

        uint32_t vind = vlast;
        do {
            if ( v < vind )
            {
                add_to_heap( v, vind );
            }
            else
            {
                add_to_heap( vind, v );
            }
            vind = mesh_.across_edge( v, vind );
        } while ( vind != vlast );

        return true;

    }

    void generate_quadratics()
    {
        FOR_EACH( it, quadratic_ )
        {
            it->clear();
        }

        FOR_EACH( it, mesh_.faces )
        {
            vl::vec< Float, 3 > &v0 = points_[ it->v0() ];
            vl::vec< Float, 3 > &v1 = points_[ it->v1() ];
            vl::vec< Float, 3 > &v2 = points_[ it->v2() ];

            vl::vec< Float, 3 > a = cross( v1 - v0, v2 - v0 );
            Float area = normalize( a );

            detail::quadratic< Float > q( a[ 0 ], a[ 1 ], a[ 2 ], -dot( a, v0 ) );

            q *= ( area * 2.0 );

            quadratic_[ it->v0() ] += q;
            quadratic_[ it->v1() ] += q;
            quadratic_[ it->v2() ] += q;
        }

        //FOR_EACH( it, d_.vd_ )
        //{
            //std::cout << it->quadratic_ << "\n";
        //}


    }

    void generate_normals()
    {
        std::vector< int > counts( size_ );
        std::fill_n( counts.begin(), size_, 0 );

        FOR_EACH( it, normals_ )
        {
            (*it) = vl::vec< Float, 3 >::zero;
        }

        FOR_EACH( it, mesh_.faces )
        {
            vl::vec< Float, 3 > &v0 = points_[ it->v0() ];
            vl::vec< Float, 3 > &v1 = points_[ it->v1() ];
            vl::vec< Float, 3 > &v2 = points_[ it->v2() ];

            vl::vec< Float, 3 > center( v0 + v1 + v2 );
            center /= 3;

            vl::vec< Float, 3 > n( norm( cross( v1 - v0, v2 - v0 ) ) );
            //n = norm( n ); // / n_len;
            normals_[ it->v0() ] += n * len( points_[ it->v0() ] - center );
            normals_[ it->v1() ] += n * len( points_[ it->v1() ] - center );
            normals_[ it->v2() ] += n * len( points_[ it->v2() ] - center );

            ++counts[ it->v0() ];
            ++counts[ it->v1() ];
            ++counts[ it->v2() ];
        }

        for ( std::size_t i = 0; i < size_; ++i )
        {
            if ( counts[ i ] > 0 )
            {
                //normals_[ i ] /= static_cast< Float >( counts[ i ] );
                //normalize( normals_[ i ] );
            }
        }

    }

    void add_to_heap( uint32_t v0, uint32_t v1 )
    {
        const uint64_t e = detail::make_edge( v0, v1 );

        ZI_ASSERT_0( heap_.key_count( e ) );

        if ( !check_valid_edge( e ) )
        {
            return;
        }

        //if ( invalid_.count( e ) )
        //{
            //return;
        //}

        //if ( !check_topology( e ) )
        //{
        //return;
        //}

        detail::quadratic< Float > q( quadratic_[ v0 ] );
        q += quadratic_[ v1 ];

        vl::vec< Float, 3 > pos( 0 );

        if ( !q.optimize( pos ) )
        {
            if ( !q.optimize( pos, points_[ v0 ], points_[ v1 ] ) )
            {
            //std::cout << "YEA\n";
                pos  = points_[ v0 ];
                pos += points_[ v1 ];
                pos *= 0.5;
            }
        }

        //std::cout << "ADDING TO HEAP: " << points_[ v0 ]
        //<< ", " << points_[ v1 ] << " ::: " << pos << "\n\n";

        //if ( check_inversion( e, pos ) < 0.01 ) // todo: better
        //{
        //return;
        //}

/*        std::ostringstream oss;

        oss << "SUM = " << q.evaluate( pos )
            << " ?= " << quadratic_[ v0 ].evaluate( pos ) + quadratic_[ v1 ].evaluate( pos )
            << " == " << quadratic_[ v0 ].evaluate( pos )
            << " + "  << quadratic_[ v1 ].evaluate( pos )
            << " ::: " << std::numeric_limits< double >::epsilon()
            << " ::: " << std::numeric_limits< double >::round_error()
            << "\n\n";

        std::cout << oss.str() << std::flush ;
*/

        Float val = q.evaluate( pos );
        if ( val < std::numeric_limits< Float >::epsilon() )
        {
            val = static_cast< Float >( 0 );
        }

        heap_.insert( heap_entry( e, val, pos ) );
    }

    void init_heap()
    {
        FOR_EACH( it, mesh_.faces )
        {
            if ( it->v0() < it->v1() )
            {
                add_to_heap( it->v0(), it->v1() );
            }

            if ( it->v1() < it->v2() )
            {
                add_to_heap( it->v1(), it->v2() );
            }

            if ( it->v2() < it->v0() )
            {
                add_to_heap( it->v2(), it->v0() );
            }
        }
    }

};

} // namespace mesh
} // namespace zi

#endif
