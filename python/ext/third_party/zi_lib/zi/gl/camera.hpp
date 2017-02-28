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

#ifndef ZI_GL_CAMERA_HPP
#define ZI_GL_CAMERA_HPP 1

#include <zi/gl/gl.hpp>
#include <zi/gl/glu.hpp>

#include <zi/vl/vector.hpp>
#include <zi/vl/matrix.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/bits/shared_ptr.hpp>

#include <functional>

namespace zi {
namespace gl {

class camera: non_copyable
{
private:

    static const double pi_over_2_deg = 1.5707963267948966192313216916397514L / 180.0;

    class camera_operation_impl: non_copyable
    {
    protected:
        camera *camera_;
        int    x_      ;
        int    y_      ;

        camera_operation_impl( camera *c, int x, int y )
            : camera_( c ), x_( x ), y_( y )
        {
        }

    public:

        virtual ~camera_operation_impl()
        {
        }

        virtual void update( int x, int y ) = 0;

        void finish()
        {
            if ( camera_ )
            {
                camera *c = camera_;
                camera_ = 0;
                c->finish_operation_();
            }
        }
    };

    class camera_rotation_impl: public camera_operation_impl
    {
    private:
        vl::mat4f rotation_;

        camera_rotation_impl( const vl::mat4f& r, camera *c, int x, int y )
            : camera_operation_impl( c, x, y ),
              rotation_( r )
        {
        }

    public:
        void update( int x, int y )
        {
            if ( camera_ )
            {
                camera_->apply_rotation_drag( rotation_, x_, y_, x, y );
            }
        }

        friend class camera;
    };

    class camera_translation_impl: public camera_operation_impl
    {
    private:
        vl::vec3f center_;

        camera_translation_impl( const vl::vec3f& center, camera *c, int x, int y )
            : camera_operation_impl( c, x, y ),
              center_( center )
        {
        }

    public:
        void update( int x, int y )
        {
            if ( camera_ )
            {
                camera_->apply_translation_drag( center_, x_, y_, x, y );
            }
        }

        friend class camera;
    };

    class camera_zoom_impl: public camera_operation_impl
    {
    private:
        float distance_;

        camera_zoom_impl( float d, camera *c, int x, int y )
            : camera_operation_impl( c, x, y ),
              distance_( d )
        {
        }

    public:
        void update( int x, int y )
        {
            if ( camera_ )
            {
                camera_->apply_zoom_drag( distance_, x_, y_, x, y );
            }
        }

        friend class camera;

    };

    void finish_operation_()
    {
        operation_.reset();
    }

    void apply_rotation_drag( const vl::mat4f& r, int sxi, int syi, int cxi, int cyi )
    {
        double sx = static_cast< double >( sxi ) - dimensions_.at( 0 ) / 2;
        double sy = - static_cast< double >( syi ) + dimensions_.at( 1 ) / 2;

        double ex = static_cast< double >( cxi ) - dimensions_.at( 0 ) / 2;
        double ey = - static_cast< double >( cyi ) + dimensions_.at( 1 ) / 2;

        double scale = std::min( dimensions_.at( 0 ), dimensions_.at( 1 ) );

        sx /= scale;
        sy /= scale;
        ex /= scale;
        ey /= scale;

        double sl = hypot( sx, sy );
        double el = hypot( ex, ey );

        if ( sl > 1.0 )
        {
            sx /= sl;
            sy /= sl;
            sl = 1.0;
        }

        if ( el > 1.0 )
        {
            ex /= el;
            ey /= el;
            el = 1.0;
        }

        double sz = std::sqrt( 1.0 - sl * sl );
        double ez = std::sqrt( 1.0 - el * el );

        double dp = sx * ex + sy * ey + sz * ez;

        if ( dp != 1 )
        {
            rotation_.make_rotation( vl::vec3f( sy * ez - ey * sz,
                                                sz * ex - ez * sx,
                                                sx * ey - ex * sy ),
                                     2.0 * std::acos( dp ) );
            rotation_ *= r;

        }
        else
        {
            rotation_ = r;
        }

    }

    void apply_translation_drag( const vl::vec3f& c, int sx, int sy, int cx, int cy )
    {

        sx -= viewport_.at( 0 );
        sy -= viewport_.at( 1 );

        cx -= viewport_.at( 0 );
        cy -= viewport_.at( 1 );


        double d = static_cast< double >( viewport_.at( 3 ) ) / 2.0;
        d /= std::tan( perspective_.at( 0 ) * camera::pi_over_2_deg );

        double su = -sy + viewport_.at( 3 ) / 2.0;
        double cu = -cy + viewport_.at( 3 ) / 2.0;

        double sr = sx - viewport_.at( 2 ) / 2.0;
        double cr = cx - viewport_.at( 2 ) / 2.0;

        float dr = cr - sr;
        float du = cu - su;

        dr *= -distance_ / d;
        du *= -distance_ / d;

        center_ = c
            + dr * vl::vec3f( rotation_.at( 0, 0 ),
                              rotation_.at( 0, 1 ),
                              rotation_.at( 0, 2 ) )
            + du * vl::vec3f( rotation_.at( 1, 0 ),
                              rotation_.at( 1, 1 ),
                              rotation_.at( 1, 2 ) );

    }

    void apply_zoom_drag( float d, int, int sy, int, int cy )
    {
        double delta = static_cast< double >( cy - sy ) / viewport_.at( 3 );

        distance_ = d * std::exp( delta );
    }



public:

    friend class camera_operation_impl  ;
    friend class camera_rotation_impl   ;
    friend class camera_translation_impl;
    friend class camera_zoom_impl       ;

    struct operation
    {
    private:
        shared_ptr< camera_operation_impl > op_;

        operation( shared_ptr< camera_operation_impl > op )
            : op_( op )
        {
        }

    public:
        friend class camera;

        void update( int x, int y )
        {
            op_->update( x, y );
        }

        void finish( int x, int y )
        {
            op_->update( x, y );
            op_->finish();
        }

        void finish()
        {
            op_->finish();
        }

    };

    void dimensions( int w, int h )
    {
        dimensions_.at( 0 ) = w;
        dimensions_.at( 1 ) = h;
    }

    void viewport( int l, int t, int w, int h )
    {
        viewport_.at( 0 ) = l;
        viewport_.at( 1 ) = t;
        viewport_.at( 2 ) = w;
        viewport_.at( 3 ) = h;
        perspective_.at( 1 ) = static_cast< float >( w ) / h;
    }

    void perspective( float fov )
    {
        perspective_.at( 0 ) = fov;
    }

    void center( const vl::vec3f& center )
    {
        center_ = center;
    }

    void center( float x, float y, float z )
    {
        center_.set( x, y, z );
    }

    vl::vec3f center() const
    {
        return center_;
    }

    void distance( float d )
    {
        distance_ = d;
    }

    float distance() const
    {
        return distance_;
    }

    void rotation( const vl::mat4f& rot )
    {
        rotation_ = rot;
    }

    vl::mat4f rotation() const
    {
        return rotation_;
    }

    operation start_translation( int x, int y )
    {
        operation_ = shared_ptr< camera_operation_impl >
            ( new camera_translation_impl( center_, this, x, y ) );
        return operation( operation_ );
    }

    operation start_zoom( int x, int y )
    {
        operation_ = shared_ptr< camera_operation_impl >
            ( new camera_zoom_impl( distance_, this, x, y ) );
        return operation( operation_ );
    }

    operation start_rotation( int x, int y )
    {
        operation_ = shared_ptr< camera_operation_impl >
            ( new camera_rotation_impl( rotation_, this, x, y ) );
        return operation( operation_ );
    }

    void apply_viewport() const
    {
        glViewport( viewport_.at( 0 ), viewport_.at( 1 ), viewport_.at( 2 ), viewport_.at( 3 ) );
    }

    void apply_perspective() const
    {
        gluPerspective( perspective_.at( 0 ), perspective_.at( 1 ), 1.0, 1000.0 );
    }

    void apply_modelview() const
    {
        gluLookAt( 0, 0, distance_, 0, 0, 0, 0, 1.0, 0 );

        vl::mat4f m( rotation_ );

        glMultTransposeMatrixf( m.data() );

        glTranslatef( -center_.at( 0 ), -center_.at( 1 ), -center_.at( 2 ) );
    }

    void update_operation( int x, int y )
    {
        if ( operation_ )
        {
            operation_->update( x, y );
        }
    }

    void finish_operation( int x, int y )
    {
        if ( operation_ )
        {
            operation_->update( x, y );
            operation_->finish();
        }
    }

    void finish_operation()
    {
        if ( operation_ )
        {
            operation_->finish();
        }
    }

private:

    vl::vec2i dimensions_ ;
    vl::vec4i viewport_   ;
    vl::vec2f perspective_;

    vl::vec3f center_     ;
    vl::mat4f rotation_   ;

    float distance_;

    shared_ptr< camera_operation_impl > operation_;

public:

    camera()
        : dimensions_(),
          viewport_(),
          perspective_(),
          center_(),
          rotation_(),
          distance_(),
          operation_()
    {
        rotation_.to_eye();
    }

};

} // namespace gl
} // namespace zi

#endif

