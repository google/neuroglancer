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
// link against glut and glu ( e.g. -lglut -lGLU )
//

#include <zi/gl/glut.hpp>
#include <zi/gl/camera.hpp>

#include <cstdlib>

bool is_wire = false;
zi::gl::camera camera;

void reshape_func( int w, int h )
{
    camera.dimensions( w, h );

    camera.viewport( 0, 0, w, h );
    camera.apply_viewport();

    zi::gl::glMatrixMode( zi::gl::projection );
    zi::gl::glLoadIdentity();

    camera.perspective( 50 );
    camera.apply_perspective();
}

void keyboard_func( unsigned char key, int x, int y )
{
    switch ( key )
    {
    case 27:
        exit( 0 );
        break;
    default:
        is_wire = !is_wire;
    }

    zi::gl::glutPostRedisplay();
}


void draw_scene(void)
{
    zi::gl::glClear(zi::gl::color_buffer_bit | zi::gl::depth_buffer_bit);

    zi::gl::glMatrixMode( zi::gl::modelview );
    zi::gl::glLoadIdentity();

    camera.apply_modelview();

    float lt_diff[] = { 1.0, 1.0, 1.0, 1.0 };
    float lt_pos[]  = { -130.0, -130.0, 150.0, 1.0 };

    zi::gl::glLightfv(zi::gl::light0, zi::gl::diffuse,  lt_diff );
    zi::gl::glLightfv(zi::gl::light0, zi::gl::position, lt_pos  );

    zi::gl::glEnable( zi::gl::depth_test );
    zi::gl::glEnable( zi::gl::lighting );
    zi::gl::glEnable( zi::gl::light0 );

    zi::gl::glShadeModel( zi::gl::smooth );
    zi::gl::glPolygonMode( zi::gl::front_and_back, zi::gl::fill );

    zi::gl::glClearColor( 0, 0, 0, 1 );

    float diff_color[] = { 0.4, 0.4, 0.4, 1 };
    float spec_color[] = { 0.9, 0.9, 0.9, 1 };
    float shininess[] = { 50.0 };

    zi::gl::glMaterialfv( zi::gl::front_and_back, zi::gl::ambient_and_diffuse, diff_color );
    zi::gl::glMaterialfv( zi::gl::front_and_back, zi::gl::specular, spec_color );
    zi::gl::glMaterialfv( zi::gl::front_and_back, zi::gl::shininess, shininess );

    zi::gl::glEnable( zi::gl::color_material );

    zi::gl::glColor4f( 0.9, 0.9, 0.5, 1 );

    if ( is_wire )
    {
        zi::gl::glutWireTeapot( 20.0 );
    }
    else
    {
        zi::gl::glutSolidTeapot( 20.0 );
    }


    zi::gl::glutSwapBuffers();
}


void timer_func( int t )
{
    // zi::gl::glutPostRedisplay();
    zi::gl::glutTimerFunc(t, timer_func, t);
}

void mouse_func( int button, int state, int x, int y )
{
    if ( state == zi::glut::down )
    {
        switch ( button )
        {
        case zi::glut::left_button:
            camera.start_translation( x, y );
            break;

        case zi::glut::middle_button:
            camera.start_zoom( x, y );
            break;

        case zi::glut::right_button:
            camera.start_rotation( x, y );
            break;

        }
    }
    else
    {
        camera.finish_operation( x, y );
        zi::gl::glutPostRedisplay();
    }

}

void motion_func( int x, int y )
{
    camera.update_operation( x, y );
    camera.apply_modelview();
    zi::gl::glutPostRedisplay();
}



int main( int argc, char* argv[] ) {

    zi::gl::glutInit( &argc, argv );
    zi::gl::glutInitDisplayMode( zi::glut::t_double |
                                 zi::glut::rgb |
                                 zi::glut::depth );

    zi::gl::glutInitWindowPosition( 60, 60 );
    zi::gl::glutInitWindowSize( 600, 600 );
    zi::gl::glutCreateWindow("Test zi/gl/glut.hpp");

    zi::gl::glutReshapeFunc( reshape_func );
    zi::gl::glutDisplayFunc( draw_scene );

    camera.dimensions( 600, 600 );
    camera.distance( 150 );
    camera.center( 0, 0, 0 );
    camera.viewport( 0, 0, 600, 600 );
    camera.perspective( 50 );

    zi::gl::glutTimerFunc( 10, timer_func, 10 );
    zi::gl::glutKeyboardFunc( keyboard_func );
    zi::gl::glutMouseFunc( mouse_func );
    zi::gl::glutMotionFunc( motion_func );


    zi::gl::glutMainLoop();

}

