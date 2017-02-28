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

#ifndef ZI_GL_GLUT_HPP
#define ZI_GL_GLUT_HPP 1

#include <zi/gl/gl.hpp>

#include <zi/gl/detail/gl_prefix.hpp>

namespace zi {
namespace gl {

struct glut
{

    static const int glut_key_f1                   = 0x0001;
    static const int key_f2                        = 0x0002;
    static const int key_f3                        = 0x0003;
    static const int key_f4                        = 0x0004;
    static const int key_f5                        = 0x0005;
    static const int key_f6                        = 0x0006;
    static const int key_f7                        = 0x0007;
    static const int key_f8                        = 0x0008;
    static const int key_f9                        = 0x0009;
    static const int key_f10                       = 0x000a;
    static const int key_f11                       = 0x000b;
    static const int key_f12                       = 0x000c;
    static const int key_left                      = 0x0064;
    static const int key_up                        = 0x0065;
    static const int key_right                     = 0x0066;
    static const int key_down                      = 0x0067;
    static const int key_page_up                   = 0x0068;
    static const int key_page_down                 = 0x0069;
    static const int key_home                      = 0x006a;
    static const int key_end                       = 0x006b;
    static const int key_insert                    = 0x006c;

    static const int left_button                   = 0x0000;
    static const int middle_button                 = 0x0001;
    static const int right_button                  = 0x0002;
    static const int down                          = 0x0000;
    static const int up                            = 0x0001;
    static const int left                          = 0x0000;
    static const int entered                       = 0x0001;

    static const int rgb                           = 0x0000;
    static const int rgba                          = 0x0000;
    static const int index                         = 0x0001;
    static const int t_single                      = 0x0000;
    static const int t_double                      = 0x0002;
    static const int accum                         = 0x0004;
    static const int alpha                         = 0x0008;
    static const int depth                         = 0x0010;
    static const int stencil                       = 0x0020;
    static const int multisample                   = 0x0080;
    static const int stereo                        = 0x0100;
    static const int luminance                     = 0x0200;

    static const int menu_not_in_use               = 0x0000;
    static const int menu_in_use                   = 0x0001;
    static const int not_visible                   = 0x0000;
    static const int visible                       = 0x0001;
    static const int hidden                        = 0x0000;
    static const int fully_retained                = 0x0001;
    static const int partially_retained            = 0x0002;
    static const int fully_covered                 = 0x0003;

    static const int window_x                      = 0x0064;
    static const int window_y                      = 0x0065;
    static const int window_width                  = 0x0066;
    static const int window_height                 = 0x0067;
    static const int window_buffer_size            = 0x0068;
    static const int window_stencil_size           = 0x0069;
    static const int window_depth_size             = 0x006a;
    static const int window_red_size               = 0x006b;
    static const int window_green_size             = 0x006c;
    static const int window_blue_size              = 0x006d;
    static const int window_alpha_size             = 0x006e;
    static const int window_accum_red_size         = 0x006f;
    static const int window_accum_green_size       = 0x0070;
    static const int window_accum_blue_size        = 0x0071;
    static const int window_accum_alpha_size       = 0x0072;
    static const int window_doublebuffer           = 0x0073;
    static const int window_rgba                   = 0x0074;
    static const int window_parent                 = 0x0075;
    static const int window_num_children           = 0x0076;
    static const int window_colormap_size          = 0x0077;
    static const int window_num_samples            = 0x0078;
    static const int window_stereo                 = 0x0079;
    static const int window_cursor                 = 0x007a;

    static const int screen_width                  = 0x00c8;
    static const int screen_height                 = 0x00c9;
    static const int screen_width_mm               = 0x00ca;
    static const int screen_height_mm              = 0x00cb;
    static const int menu_num_items                = 0x012c;
    static const int display_mode_possible         = 0x0190;
    static const int init_window_x                 = 0x01f4;
    static const int init_window_y                 = 0x01f5;
    static const int init_window_width             = 0x01f6;
    static const int init_window_height            = 0x01f7;
    static const int init_display_mode             = 0x01f8;
    static const int elapsed_time                  = 0x02bc;
    static const int window_format_id              = 0x007b;

    static const int has_keyboard                  = 0x0258;
    static const int has_mouse                     = 0x0259;
    static const int has_spaceball                 = 0x025a;
    static const int has_dial_and_button_box       = 0x025b;
    static const int has_tablet                    = 0x025c;
    static const int num_mouse_buttons             = 0x025d;
    static const int num_spaceball_buttons         = 0x025e;
    static const int num_button_box_buttons        = 0x025f;
    static const int num_dials                     = 0x0260;
    static const int num_tablet_buttons            = 0x0261;
    static const int device_ignore_key_repeat      = 0x0262;
    static const int device_key_repeat             = 0x0263;
    static const int has_joystick                  = 0x0264;
    static const int owns_joystick                 = 0x0265;
    static const int joystick_buttons              = 0x0266;
    static const int joystick_axes                 = 0x0267;
    static const int joystick_poll_rate            = 0x0268;

    static const int overlay_possible              = 0x0320;
    static const int layer_in_use                  = 0x0321;
    static const int has_overlay                   = 0x0322;
    static const int transparent_index             = 0x0323;
    static const int normal_damaged                = 0x0324;
    static const int overlay_damaged               = 0x0325;

    static const int video_resize_possible         = 0x0384;
    static const int video_resize_in_use           = 0x0385;
    static const int video_resize_x_delta          = 0x0386;
    static const int video_resize_y_delta          = 0x0387;
    static const int video_resize_width_delta      = 0x0388;
    static const int video_resize_height_delta     = 0x0389;
    static const int video_resize_x                = 0x038a;
    static const int video_resize_y                = 0x038b;
    static const int video_resize_width            = 0x038c;
    static const int video_resize_height           = 0x038d;

    static const int normal                        = 0x0000;
    static const int overlay                       = 0x0001;

    static const int active_shift                  = 0x0001;
    static const int active_ctrl                   = 0x0002;
    static const int active_alt                    = 0x0004;

    static const int cursor_right_arrow            = 0x0000;
    static const int cursor_left_arrow             = 0x0001;
    static const int cursor_info                   = 0x0002;
    static const int cursor_destroy                = 0x0003;
    static const int cursor_help                   = 0x0004;
    static const int cursor_cycle                  = 0x0005;
    static const int cursor_spray                  = 0x0006;
    static const int cursor_wait                   = 0x0007;
    static const int cursor_text                   = 0x0008;
    static const int cursor_crosshair              = 0x0009;
    static const int cursor_up_down                = 0x000a;
    static const int cursor_left_right             = 0x000b;
    static const int cursor_top_side               = 0x000c;
    static const int cursor_bottom_side            = 0x000d;
    static const int cursor_left_side              = 0x000e;
    static const int cursor_right_side             = 0x000f;
    static const int cursor_top_left_corner        = 0x0010;
    static const int cursor_top_right_corner       = 0x0011;
    static const int cursor_bottom_right_corner    = 0x0012;
    static const int cursor_bottom_left_corner     = 0x0013;
    static const int cursor_inherit                = 0x0064;
    static const int cursor_none                   = 0x0065;
    static const int cursor_full_crosshair         = 0x0066;

    static const int red                           = 0x0000;
    static const int green                         = 0x0001;
    static const int blue                          = 0x0002;

    static const int key_repeat_off                = 0x0000;
    static const int key_repeat_on                 = 0x0001;
    static const int key_repeat_default            = 0x0002;

    static const int joystick_button_a             = 0x0001;
    static const int joystick_button_b             = 0x0002;
    static const int joystick_button_c             = 0x0004;
    static const int joystick_button_d             = 0x0008;

    static const int game_mode_active              = 0x0000;
    static const int game_mode_possible            = 0x0001;
    static const int game_mode_width               = 0x0002;
    static const int game_mode_height              = 0x0003;
    static const int game_mode_pixel_depth         = 0x0004;
    static const int game_mode_refresh_rate        = 0x0005;
    static const int game_mode_display_changed     = 0x0006;

};

ZI_GLAPI void     ZI_GLAPI_ENTRY glutInit( int* pargc, char** argv );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutInitWindowPosition( int x, int y );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutInitWindowSize( int width, int height );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutInitDisplayMode( unsigned int displayMode );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutInitDisplayString( const char* displayMode );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutMainLoop( void );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutCreateWindow( const char* title );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutCreateSubWindow( int window, int x, int y, int width, int height );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutDestroyWindow( int window );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSetWindow( int window );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutGetWindow( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSetWindowTitle( const char* title );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSetIconTitle( const char* title );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutReshapeWindow( int width, int height );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutPositionWindow( int x, int y );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutShowWindow( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutHideWindow( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutIconifyWindow( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutPushWindow( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutPopWindow( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutFullScreen( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutPostWindowRedisplay( int window );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutPostRedisplay( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSwapBuffers( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWarpPointer( int x, int y );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSetCursor( int cursor );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutEstablishOverlay( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutRemoveOverlay( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutUseLayer( gl_enum layer );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutPostOverlayRedisplay( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutPostWindowOverlayRedisplay( int window );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutShowOverlay( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutHideOverlay( void );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutCreateMenu( void (* callback)( int menu ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutDestroyMenu( int menu );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutGetMenu( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSetMenu( int menu );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutAddMenuEntry( const char* label, int value );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutAddSubMenu( const char* label, int subMenu );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutChangeToMenuEntry( int item, const char* label, int value );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutChangeToSubMenu( int item, const char* label, int value );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutRemoveMenuItem( int item );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutAttachMenu( int button );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutDetachMenu( int button );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutTimerFunc( unsigned int time, void (* callback)( int ), int value );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutIdleFunc( void (* callback)( void ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutKeyboardFunc( void (* callback)( unsigned char, int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSpecialFunc( void (* callback)( int, int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutReshapeFunc( void (* callback)( int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutVisibilityFunc( void (* callback)( int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutDisplayFunc( void (* callback)( void ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutMouseFunc( void (* callback)( int, int, int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutMotionFunc( void (* callback)( int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutPassiveMotionFunc( void (* callback)( int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutEntryFunc( void (* callback)( int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutKeyboardUpFunc( void (* callback)( unsigned char, int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSpecialUpFunc( void (* callback)( int, int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutJoystickFunc( void (* callback)( unsigned int, int, int, int ), int pollInterval );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutMenuStateFunc( void (* callback)( int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutMenuStatusFunc( void (* callback)( int, int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutOverlayDisplayFunc( void (* callback)( void ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWindowStatusFunc( void (* callback)( int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSpaceballMotionFunc( void (* callback)( int, int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSpaceballRotateFunc( void (* callback)( int, int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSpaceballButtonFunc( void (* callback)( int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutButtonBoxFunc( void (* callback)( int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutDialsFunc( void (* callback)( int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutTabletMotionFunc( void (* callback)( int, int ) );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutTabletButtonFunc( void (* callback)( int, int, int, int ) );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutGet( gl_enum query );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutDeviceGet( gl_enum query );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutGetModifiers( void );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutLayerGet( gl_enum query );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutBitmapCharacter( void* font, int character );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutBitmapWidth( void* font, int character );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutStrokeCharacter( void* font, int character );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutStrokeWidth( void* font, int character );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutBitmapLength( void* font, const unsigned char* string );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutStrokeLength( void* font, const unsigned char* string );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireCube( gl_double size );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidCube( gl_double size );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireSphere( gl_double radius, gl_int slices, gl_int stacks );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidSphere( gl_double radius, gl_int slices, gl_int stacks );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireCone( gl_double base, gl_double height, gl_int slices, gl_int stacks );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidCone( gl_double base, gl_double height, gl_int slices, gl_int stacks );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireTorus( gl_double innerRadius, gl_double outerRadius, gl_int sides, gl_int rings );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidTorus( gl_double innerRadius, gl_double outerRadius, gl_int sides, gl_int rings );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireDodecahedron( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidDodecahedron( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireOctahedron( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidOctahedron( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireTetrahedron( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidTetrahedron( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireIcosahedron( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidIcosahedron( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutWireTeapot( gl_double size );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSolidTeapot( gl_double size );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutGameModeString( const char* string );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutEnterGameMode( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutLeaveGameMode( void );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutGameModeGet( gl_enum query );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutVideoResizeGet( gl_enum query );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSetupVideoResizing( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutStopVideoResizing( void );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutVideoResize( int x, int y, int width, int height );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutVideoPan( int x, int y, int width, int height );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSetColor( int color, gl_float red, gl_float green, gl_float blue );
ZI_GLAPI gl_float ZI_GLAPI_ENTRY glutGetColor( int color, int component );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutCopyColormap( int window );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutIgnoreKeyRepeat( int ignore );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutSetKeyRepeat( int repeatMode );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutForceJoystickFunc( void );
ZI_GLAPI int      ZI_GLAPI_ENTRY glutExtensionSupported( const char* extension );
ZI_GLAPI void     ZI_GLAPI_ENTRY glutReportErrors( void );

} // namespace gl

using gl::glut;

} // namespace zi

#include <zi/gl/detail/gl_suffix.hpp>

#include <zi/gl/gl_1_1.hpp>

#endif
