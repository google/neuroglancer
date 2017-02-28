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

#ifndef ZI_GL_GL_HPP
#define ZI_GL_GL_HPP 1

#include <zi/gl/detail/types.hpp>

#include <zi/gl/detail/gl_prefix.hpp>

namespace zi {
namespace gl {


static const int c_false                             = 0x0;
static const int c_true                              = 0x1;

static const int t_byte                              = 0x1400;
static const int t_unsigned_byte                     = 0x1401;
static const int t_short                             = 0x1402;
static const int t_unsigned_short                    = 0x1403;
static const int t_nt                                = 0x1404;
static const int t_unsigned_int                      = 0x1405;
static const int t_float                             = 0x1406;
static const int t_2_bytes                           = 0x1407;
static const int t_3_bytes                           = 0x1408;
static const int t_4_bytes                           = 0x1409;
static const int t_double                            = 0x140a;

static const int points                              = 0x0000;
static const int lines                               = 0x0001;
static const int line_loop                           = 0x0002;
static const int line_strip                          = 0x0003;
static const int triangles                           = 0x0004;
static const int triangle_strip                      = 0x0005;
static const int triangle_fan                        = 0x0006;
static const int quads                               = 0x0007;
static const int quad_strip                          = 0x0008;
static const int polygon                             = 0x0009;

static const int vertex_array                        = 0x8074;
static const int normal_array                        = 0x8075;
static const int color_array                         = 0x8076;
static const int index_array                         = 0x8077;
static const int texture_coord_array                 = 0x8078;
static const int edge_flag_array                     = 0x8079;
static const int vertex_array_size                   = 0x807a;
static const int vertex_array_type                   = 0x807b;
static const int vertex_array_stride                 = 0x807c;
static const int normal_array_type                   = 0x807e;
static const int normal_array_stride                 = 0x807f;
static const int color_array_size                    = 0x8081;
static const int color_array_type                    = 0x8082;
static const int color_array_stride                  = 0x8083;
static const int index_array_type                    = 0x8085;
static const int index_array_stride                  = 0x8086;
static const int texture_coord_array_size            = 0x8088;
static const int texture_coord_array_type            = 0x8089;
static const int texture_coord_array_stride          = 0x808a;
static const int edge_flag_array_stride              = 0x808c;
static const int vertex_array_pointer                = 0x808e;
static const int normal_array_pointer                = 0x808f;
static const int color_array_pointer                 = 0x8090;
static const int index_array_pointer                 = 0x8091;
static const int texture_coord_array_pointer         = 0x8092;
static const int edge_flag_array_pointer             = 0x8093;
static const int v2f                                 = 0x2a20;
static const int v3f                                 = 0x2a21;
static const int c4ub_v2f                            = 0x2a22;
static const int c4ub_v3f                            = 0x2a23;
static const int c3f_v3f                             = 0x2a24;
static const int n3f_v3f                             = 0x2a25;
static const int c4f_n3f_v3f                         = 0x2a26;
static const int t2f_v3f                             = 0x2a27;
static const int t4f_v4f                             = 0x2a28;
static const int t2f_c4ub_v3f                        = 0x2a29;
static const int t2f_c3f_v3f                         = 0x2a2a;
static const int t2f_n3f_v3f                         = 0x2a2b;
static const int t2f_c4f_n3f_v3f                     = 0x2a2c;
static const int t4f_c4f_n3f_v4f                     = 0x2a2d;

static const int matrix_mode                         = 0x0ba0;
static const int modelview                           = 0x1700;
static const int projection                          = 0x1701;
static const int texture                             = 0x1702;

static const int point_smooth                        = 0x0b10;
static const int point_size                          = 0x0b11;
static const int point_size_granularity              = 0x0b13;
static const int point_size_range                    = 0x0b12;

static const int line_smooth                         = 0x0b20;
static const int line_stipple                        = 0x0b24;
static const int line_stipple_pattern                = 0x0b25;
static const int line_stipple_repeat                 = 0x0b26;
static const int line_width                          = 0x0b21;
static const int line_width_granularity              = 0x0b23;
static const int line_width_range                    = 0x0b22;

static const int point                               = 0x1b00;
static const int line                                = 0x1b01;
static const int fill                                = 0x1b02;
static const int cw                                  = 0x0900;
static const int ccw                                 = 0x0901;
static const int front                               = 0x0404;
static const int back                                = 0x0405;
static const int polygon_mode                        = 0x0b40;
static const int polygon_smooth                      = 0x0b41;
static const int polygon_stipple                     = 0x0b42;
static const int edge_flag                           = 0x0b43;
static const int cull_face                           = 0x0b44;
static const int cull_face_mode                      = 0x0b45;
static const int front_face                          = 0x0b46;
static const int polygon_offset_factor               = 0x8038;
static const int polygon_offset_units                = 0x2a00;
static const int polygon_offset_point                = 0x2a01;
static const int polygon_offset_line                 = 0x2a02;
static const int polygon_offset_fill                 = 0x8037;

static const int compile                             = 0x1300;
static const int compile_and_execute                 = 0x1301;
static const int list_base                           = 0x0b32;
static const int list_index                          = 0x0b33;
static const int list_mode                           = 0x0b30;

static const int never                               = 0x0200;
static const int less                                = 0x0201;
static const int equal                               = 0x0202;
static const int lequal                              = 0x0203;
static const int greater                             = 0x0204;
static const int notequal                            = 0x0205;
static const int gequal                              = 0x0206;
static const int always                              = 0x0207;
static const int depth_test                          = 0x0b71;
static const int depth_bits                          = 0x0d56;
static const int depth_clear_value                   = 0x0b73;
static const int depth_func                          = 0x0b74;
static const int depth_range                         = 0x0b70;
static const int depth_writemask                     = 0x0b72;
static const int depth_component                     = 0x1902;

static const int lighting                            = 0x0b50;
static const int light0                              = 0x4000;
static const int light1                              = 0x4001;
static const int light2                              = 0x4002;
static const int light3                              = 0x4003;
static const int light4                              = 0x4004;
static const int light5                              = 0x4005;
static const int light6                              = 0x4006;
static const int light7                              = 0x4007;
static const int spot_exponent                       = 0x1205;
static const int spot_cutoff                         = 0x1206;
static const int constant_attenuation                = 0x1207;
static const int linear_attenuation                  = 0x1208;
static const int quadratic_attenuation               = 0x1209;
static const int ambient                             = 0x1200;
static const int diffuse                             = 0x1201;
static const int specular                            = 0x1202;
static const int shininess                           = 0x1601;
static const int emission                            = 0x1600;
static const int position                            = 0x1203;
static const int spot_direction                      = 0x1204;
static const int ambient_and_diffuse                 = 0x1602;
static const int color_indexes                       = 0x1603;
static const int light_model_two_side                = 0x0b52;
static const int light_model_local_viewer            = 0x0b51;
static const int light_model_ambient                 = 0x0b53;
static const int front_and_back                      = 0x0408;
static const int shade_model                         = 0x0b54;
static const int flat                                = 0x1d00;
static const int smooth                              = 0x1d01;
static const int color_material                      = 0x0b57;
static const int color_material_face                 = 0x0b55;
static const int color_material_parameter            = 0x0b56;
static const int normalize                           = 0x0ba1;

static const int clip_plane0                         = 0x3000;
static const int clip_plane1                         = 0x3001;
static const int clip_plane2                         = 0x3002;
static const int clip_plane3                         = 0x3003;
static const int clip_plane4                         = 0x3004;
static const int clip_plane5                         = 0x3005;

static const int accum_red_bits                      = 0x0d58;
static const int accum_green_bits                    = 0x0d59;
static const int accum_blue_bits                     = 0x0d5a;
static const int accum_alpha_bits                    = 0x0d5b;
static const int accum_clear_value                   = 0x0b80;
static const int accum                               = 0x0100;
static const int add                                 = 0x0104;
static const int load                                = 0x0101;
static const int mult                                = 0x0103;
static const int Return                              = 0x0102;

static const int alpha_test                          = 0x0bc0;
static const int alpha_test_ref                      = 0x0bc2;
static const int alpha_test_func                     = 0x0bc1;

static const int blend                               = 0x0be2;
static const int blend_src                           = 0x0be1;
static const int blend_dst                           = 0x0be0;
static const int zero                                = 0x0;
static const int one                                 = 0x1;
static const int src_color                           = 0x0300;
static const int one_minus_src_color                 = 0x0301;
static const int src_alpha                           = 0x0302;
static const int one_minus_src_alpha                 = 0x0303;
static const int dst_alpha                           = 0x0304;
static const int one_minus_dst_alpha                 = 0x0305;
static const int dst_color                           = 0x0306;
static const int one_minus_dst_color                 = 0x0307;
static const int src_alpha_saturate                  = 0x0308;

static const int feedback                            = 0x1c01;
static const int render                              = 0x1c00;
static const int select                              = 0x1c02;

static const int gl_2d                               = 0x0600;
static const int gl_3d                               = 0x0601;
static const int gl_3d_color                         = 0x0602;
static const int gl_3d_color_texture                 = 0x0603;
static const int gl_4d_color_texture                 = 0x0604;
static const int point_token                         = 0x0701;
static const int line_token                          = 0x0702;
static const int line_reset_token                    = 0x0707;
static const int polygon_token                       = 0x0703;
static const int bitmap_token                        = 0x0704;
static const int draw_pixel_token                    = 0x0705;
static const int copy_pixel_token                    = 0x0706;
static const int pass_through_token                  = 0x0700;
static const int feedback_buffer_pointer             = 0x0df0;
static const int feedback_buffer_size                = 0x0df1;
static const int feedback_buffer_type                = 0x0df2;

static const int selection_buffer_pointer            = 0x0df3;
static const int selection_buffer_size               = 0x0df4;

static const int fog                                 = 0x0b60;
static const int fog_mode                            = 0x0b65;
static const int fog_density                         = 0x0b62;
static const int fog_color                           = 0x0b66;
static const int fog_index                           = 0x0b61;
static const int fog_start                           = 0x0b63;
static const int fog_end                             = 0x0b64;
static const int linear                              = 0x2601;
static const int exp                                 = 0x0800;
static const int exp2                                = 0x0801;

static const int logic_op                            = 0x0bf1;
static const int index_logic_op                      = 0x0bf1;
static const int color_logic_op                      = 0x0bf2;
static const int logic_op_mode                       = 0x0bf0;
static const int op_clear                            = 0x1500;
static const int op_set                              = 0x150f;
static const int op_copy                             = 0x1503;
static const int op_copy_inverted                    = 0x150c;
static const int op_noop                             = 0x1505;
static const int op_invert                           = 0x150a;
static const int op_and                              = 0x1501;
static const int op_nand                             = 0x150e;
static const int op_or                               = 0x1507;
static const int op_nor                              = 0x1508;
static const int op_xor                              = 0x1506;
static const int op_equiv                            = 0x1509;
static const int op_and_reverse                      = 0x1502;
static const int op_and_inverted                     = 0x1504;
static const int op_or_reverse                       = 0x150b;
static const int op_or_inverted                      = 0x150d;

static const int stencil_bits                        = 0x0d57;
static const int stencil_test                        = 0x0b90;
static const int stencil_clear_value                 = 0x0b91;
static const int stencil_func                        = 0x0b92;
static const int stencil_value_mask                  = 0x0b93;
static const int stencil_fail                        = 0x0b94;
static const int stencil_pass_depth_fail             = 0x0b95;
static const int stencil_pass_depth_pass             = 0x0b96;
static const int stencil_ref                         = 0x0b97;
static const int stencil_writemask                   = 0x0b98;
static const int stencil_index                       = 0x1901;
static const int keep                                = 0x1e00;
static const int replace                             = 0x1e01;
static const int incr                                = 0x1e02;
static const int decr                                = 0x1e03;

static const int none                                = 0x0;
static const int left                                = 0x0406;
static const int right                               = 0x0407;

static const int front_left                          = 0x0400;
static const int front_right                         = 0x0401;
static const int back_left                           = 0x0402;
static const int back_right                          = 0x0403;
static const int aux0                                = 0x0409;
static const int aux1                                = 0x040a;
static const int aux2                                = 0x040b;
static const int aux3                                = 0x040c;
static const int color_index                         = 0x1900;
static const int red                                 = 0x1903;
static const int green                               = 0x1904;
static const int blue                                = 0x1905;
static const int alpha                               = 0x1906;
static const int luminance                           = 0x1909;
static const int luminance_alpha                     = 0x190a;
static const int alpha_bits                          = 0x0d55;
static const int red_bits                            = 0x0d52;
static const int green_bits                          = 0x0d53;
static const int blue_bits                           = 0x0d54;
static const int index_bits                          = 0x0d51;
static const int subpixel_bits                       = 0x0d50;
static const int aux_buffers                         = 0x0c00;
static const int read_buffer                         = 0x0c02;
static const int draw_buffer                         = 0x0c01;
static const int doublebuffer                        = 0x0c32;
static const int stereo                              = 0x0c33;
static const int bitmap                              = 0x1a00;
static const int color                               = 0x1800;
static const int depth                               = 0x1801;
static const int stencil                             = 0x1802;
static const int dither                              = 0x0bd0;
static const int rgb                                 = 0x1907;
static const int rgba                                = 0x1908;

static const int max_list_nesting                    = 0x0b31;
static const int max_eval_order                      = 0x0d30;
static const int max_lights                          = 0x0d31;
static const int max_clip_planes                     = 0x0d32;
static const int max_texture_size                    = 0x0d33;
static const int max_pixel_map_table                 = 0x0d34;
static const int max_attrib_stack_depth              = 0x0d35;
static const int max_modelview_stack_depth           = 0x0d36;
static const int max_name_stack_depth                = 0x0d37;
static const int max_projection_stack_depth          = 0x0d38;
static const int max_texture_stack_depth             = 0x0d39;
static const int max_viewport_dims                   = 0x0d3a;
static const int max_client_attrib_stack_depth       = 0x0d3b;

static const int attrib_stack_depth                  = 0x0bb0;
static const int client_attrib_stack_depth           = 0x0bb1;
static const int color_clear_value                   = 0x0c22;
static const int color_writemask                     = 0x0c23;
static const int current_index                       = 0x0b01;
static const int current_color                       = 0x0b00;
static const int current_normal                      = 0x0b02;
static const int current_raster_color                = 0x0b04;
static const int current_raster_distance             = 0x0b09;
static const int current_raster_index                = 0x0b05;
static const int current_raster_position             = 0x0b07;
static const int current_raster_texture_coords       = 0x0b06;
static const int current_raster_position_valid       = 0x0b08;
static const int current_texture_coords              = 0x0b03;
static const int index_clear_value                   = 0x0c20;
static const int index_mode                          = 0x0c30;
static const int index_writemask                     = 0x0c21;
static const int modelview_matrix                    = 0x0ba6;
static const int modelview_stack_depth               = 0x0ba3;
static const int name_stack_depth                    = 0x0d70;
static const int projection_matrix                   = 0x0ba7;
static const int projection_stack_depth              = 0x0ba4;
static const int render_mode                         = 0x0c40;
static const int rgba_mode                           = 0x0c31;
static const int texture_matrix                      = 0x0ba8;
static const int texture_stack_depth                 = 0x0ba5;
static const int viewport                            = 0x0ba2;

static const int auto_normal                         = 0x0d80;
static const int map1_color_4                        = 0x0d90;
static const int map1_index                          = 0x0d91;
static const int map1_normal                         = 0x0d92;
static const int map1_texture_coord_1                = 0x0d93;
static const int map1_texture_coord_2                = 0x0d94;
static const int map1_texture_coord_3                = 0x0d95;
static const int map1_texture_coord_4                = 0x0d96;
static const int map1_vertex_3                       = 0x0d97;
static const int map1_vertex_4                       = 0x0d98;
static const int map2_color_4                        = 0x0db0;
static const int map2_index                          = 0x0db1;
static const int map2_normal                         = 0x0db2;
static const int map2_texture_coord_1                = 0x0db3;
static const int map2_texture_coord_2                = 0x0db4;
static const int map2_texture_coord_3                = 0x0db5;
static const int map2_texture_coord_4                = 0x0db6;
static const int map2_vertex_3                       = 0x0db7;
static const int map2_vertex_4                       = 0x0db8;
static const int map1_grid_domain                    = 0x0dd0;
static const int map1_grid_segments                  = 0x0dd1;
static const int map2_grid_domain                    = 0x0dd2;
static const int map2_grid_segments                  = 0x0dd3;
static const int coeff                               = 0x0a00;
static const int order                               = 0x0a01;
static const int domain                              = 0x0a02;

static const int perspective_correction_hint         = 0x0c50;
static const int point_smooth_hint                   = 0x0c51;
static const int line_smooth_hint                    = 0x0c52;
static const int polygon_smooth_hint                 = 0x0c53;
static const int fog_hint                            = 0x0c54;
static const int dont_care                           = 0x1100;
static const int fastest                             = 0x1101;
static const int nicest                              = 0x1102;

static const int scissor_box                         = 0x0c10;
static const int scissor_test                        = 0x0c11;

static const int map_color                           = 0x0d10;
static const int map_stencil                         = 0x0d11;
static const int index_shift                         = 0x0d12;
static const int index_offset                        = 0x0d13;
static const int red_scale                           = 0x0d14;
static const int red_bias                            = 0x0d15;
static const int green_scale                         = 0x0d18;
static const int green_bias                          = 0x0d19;
static const int blue_scale                          = 0x0d1a;
static const int blue_bias                           = 0x0d1b;
static const int alpha_scale                         = 0x0d1c;
static const int alpha_bias                          = 0x0d1d;
static const int depth_scale                         = 0x0d1e;
static const int depth_bias                          = 0x0d1f;
static const int pixel_map_s_to_s_size               = 0x0cb1;
static const int pixel_map_i_to_i_size               = 0x0cb0;
static const int pixel_map_i_to_r_size               = 0x0cb2;
static const int pixel_map_i_to_g_size               = 0x0cb3;
static const int pixel_map_i_to_b_size               = 0x0cb4;
static const int pixel_map_i_to_a_size               = 0x0cb5;
static const int pixel_map_r_to_r_size               = 0x0cb6;
static const int pixel_map_g_to_g_size               = 0x0cb7;
static const int pixel_map_b_to_b_size               = 0x0cb8;
static const int pixel_map_a_to_a_size               = 0x0cb9;
static const int pixel_map_s_to_s                    = 0x0c71;
static const int pixel_map_i_to_i                    = 0x0c70;
static const int pixel_map_i_to_r                    = 0x0c72;
static const int pixel_map_i_to_g                    = 0x0c73;
static const int pixel_map_i_to_b                    = 0x0c74;
static const int pixel_map_i_to_a                    = 0x0c75;
static const int pixel_map_r_to_r                    = 0x0c76;
static const int pixel_map_g_to_g                    = 0x0c77;
static const int pixel_map_b_to_b                    = 0x0c78;
static const int pixel_map_a_to_a                    = 0x0c79;
static const int pack_alignment                      = 0x0d05;
static const int pack_lsb_first                      = 0x0d01;
static const int pack_row_length                     = 0x0d02;
static const int pack_skip_pixels                    = 0x0d04;
static const int pack_skip_rows                      = 0x0d03;
static const int pack_swap_bytes                     = 0x0d00;
static const int unpack_alignment                    = 0x0cf5;
static const int unpack_lsb_first                    = 0x0cf1;
static const int unpack_row_length                   = 0x0cf2;
static const int unpack_skip_pixels                  = 0x0cf4;
static const int unpack_skip_rows                    = 0x0cf3;
static const int unpack_swap_bytes                   = 0x0cf0;
static const int zoom_x                              = 0x0d16;
static const int zoom_y                              = 0x0d17;

static const int texture_env                         = 0x2300;
static const int texture_env_mode                    = 0x2200;
static const int texture_1d                          = 0x0de0;
static const int texture_2d                          = 0x0de1;
static const int texture_wrap_s                      = 0x2802;
static const int texture_wrap_t                      = 0x2803;
static const int texture_mag_filter                  = 0x2800;
static const int texture_min_filter                  = 0x2801;
static const int texture_env_color                   = 0x2201;
static const int texture_gen_s                       = 0x0c60;
static const int texture_gen_t                       = 0x0c61;
static const int texture_gen_mode                    = 0x2500;
static const int texture_border_color                = 0x1004;
static const int texture_width                       = 0x1000;
static const int texture_height                      = 0x1001;
static const int texture_border                      = 0x1005;
static const int texture_components                  = 0x1003;
static const int texture_red_size                    = 0x805c;
static const int texture_green_size                  = 0x805d;
static const int texture_blue_size                   = 0x805e;
static const int texture_alpha_size                  = 0x805f;
static const int texture_luminance_size              = 0x8060;
static const int texture_intensity_size              = 0x8061;
static const int nearest_mipmap_nearest              = 0x2700;
static const int nearest_mipmap_linear               = 0x2702;
static const int linear_mipmap_nearest               = 0x2701;
static const int linear_mipmap_linear                = 0x2703;
static const int object_linear                       = 0x2401;
static const int object_plane                        = 0x2501;
static const int eye_linear                          = 0x2400;
static const int eye_plane                           = 0x2502;
static const int sphere_map                          = 0x2402;
static const int decal                               = 0x2101;
static const int modulate                            = 0x2100;
static const int nearest                             = 0x2600;
static const int repeat                              = 0x2901;
static const int clamp                               = 0x2900;
static const int s                                   = 0x2000;
static const int t                                   = 0x2001;
static const int r                                   = 0x2002;
static const int q                                   = 0x2003;
static const int texture_gen_r                       = 0x0c62;
static const int texture_gen_q                       = 0x0c63;

static const int vendor                              = 0x1f00;
static const int renderer                            = 0x1f01;
static const int version                             = 0x1f02;
static const int extensions                          = 0x1f03;

static const int no_error                            = 0x0;
static const int invalid_enum                        = 0x0500;
static const int invalid_value                       = 0x0501;
static const int invalid_operation                   = 0x0502;
static const int stack_overflow                      = 0x0503;
static const int stack_underflow                     = 0x0504;
static const int out_of_memory                       = 0x0505;

static const int current_bit                         = 0x00000001;
static const int point_bit                           = 0x00000002;
static const int line_bit                            = 0x00000004;
static const int polygon_bit                         = 0x00000008;
static const int polygon_stipple_bit                 = 0x00000010;
static const int pixel_mode_bit                      = 0x00000020;
static const int lighting_bit                        = 0x00000040;
static const int fog_bit                             = 0x00000080;
static const int depth_buffer_bit                    = 0x00000100;
static const int accum_buffer_bit                    = 0x00000200;
static const int stencil_buffer_bit                  = 0x00000400;
static const int viewport_bit                        = 0x00000800;
static const int transform_bit                       = 0x00001000;
static const int enable_bit                          = 0x00002000;
static const int color_buffer_bit                    = 0x00004000;
static const int hint_bit                            = 0x00008000;
static const int eval_bit                            = 0x00010000;
static const int list_bit                            = 0x00020000;
static const int texture_bit                         = 0x00040000;
static const int scissor_bit                         = 0x00080000;
static const int all_attrib_bits                     = 0x000fffff;


/*
 * Miscellaneous
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glClearIndex( gl_float c );
ZI_GLAPI void ZI_GLAPI_ENTRY glClearColor( gl_clampf red, gl_clampf green, gl_clampf blue, gl_clampf alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glClear( gl_bitfield mask );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexMask( gl_uint mask );
ZI_GLAPI void ZI_GLAPI_ENTRY glColorMask( gl_boolean red, gl_boolean green, gl_boolean blue, gl_boolean alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glAlphaFunc( gl_enum func, gl_clampf ref );
ZI_GLAPI void ZI_GLAPI_ENTRY glBlendFunc( gl_enum sfactor, gl_enum dfactor );
ZI_GLAPI void ZI_GLAPI_ENTRY glLogicOp( gl_enum opcode );
ZI_GLAPI void ZI_GLAPI_ENTRY glCullFace( gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glFrontFace( gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glPointSize( gl_float size );
ZI_GLAPI void ZI_GLAPI_ENTRY glLineWidth( gl_float width );
ZI_GLAPI void ZI_GLAPI_ENTRY glLineStipple( gl_int factor, gl_ushort pattern );
ZI_GLAPI void ZI_GLAPI_ENTRY glPolygonMode( gl_enum face, gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glPolygonOffset( gl_float factor, gl_float units );
ZI_GLAPI void ZI_GLAPI_ENTRY glPolygonStipple( const gl_ubyte *mask );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetPolygonStipple( gl_ubyte *mask );
ZI_GLAPI void ZI_GLAPI_ENTRY glEdgeFlag( gl_boolean flag );
ZI_GLAPI void ZI_GLAPI_ENTRY glEdgeFlagv( const gl_boolean *flag );
ZI_GLAPI void ZI_GLAPI_ENTRY glScissor( gl_int x, gl_int y, gl_sizei width, gl_sizei height);
ZI_GLAPI void ZI_GLAPI_ENTRY glClipPlane( gl_enum plane, const gl_double *equation );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetClipPlane( gl_enum plane, gl_double *equation );
ZI_GLAPI void ZI_GLAPI_ENTRY glDrawBuffer( gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glReadBuffer( gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glEnable( gl_enum cap );
ZI_GLAPI void ZI_GLAPI_ENTRY glDisable( gl_enum cap );
ZI_GLAPI gl_boolean ZI_GLAPI_ENTRY glIsEnabled( gl_enum cap );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetBooleanv( gl_enum pname, gl_boolean *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetDoublev( gl_enum pname, gl_double *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetFloatv( gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetIntegerv( gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glPushAttrib( gl_bitfield mask );
ZI_GLAPI void ZI_GLAPI_ENTRY glPopAttrib( void );
ZI_GLAPI gl_int ZI_GLAPI_ENTRY glRenderMode( gl_enum mode );
ZI_GLAPI gl_enum ZI_GLAPI_ENTRY glGetError( void );
ZI_GLAPI const gl_ubyte * ZI_GLAPI_ENTRY glGetString( gl_enum name );
ZI_GLAPI void ZI_GLAPI_ENTRY glFinish( void );
ZI_GLAPI void ZI_GLAPI_ENTRY glFlush( void );
ZI_GLAPI void ZI_GLAPI_ENTRY glHint( gl_enum target, gl_enum mode );

/*
 * Depth Buffer
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glClearDepth( gl_clampd depth );
ZI_GLAPI void ZI_GLAPI_ENTRY glDepthFunc( gl_enum func );
ZI_GLAPI void ZI_GLAPI_ENTRY glDepthMask( gl_boolean flag );
ZI_GLAPI void ZI_GLAPI_ENTRY glDepthRange( gl_clampd near_val, gl_clampd far_val );

/*
 * Accumulation Buffer
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glClearAccum( gl_float red, gl_float green, gl_float blue, gl_float alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glAccum( gl_enum op, gl_float value );

/*
 * Transformation
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glMatrixMode( gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glOrtho( gl_double left, gl_double right, gl_double bottom, gl_double top, gl_double near_val, gl_double far_val );
ZI_GLAPI void ZI_GLAPI_ENTRY glFrustum( gl_double left, gl_double right, gl_double bottom, gl_double top, gl_double near_val, gl_double far_val );
ZI_GLAPI void ZI_GLAPI_ENTRY glViewport( gl_int x, gl_int y, gl_sizei width, gl_sizei height );
ZI_GLAPI void ZI_GLAPI_ENTRY glPushMatrix( void );
ZI_GLAPI void ZI_GLAPI_ENTRY glPopMatrix( void );
ZI_GLAPI void ZI_GLAPI_ENTRY glLoadIdentity( void );
ZI_GLAPI void ZI_GLAPI_ENTRY glLoadMatrixd( const gl_double *m );
ZI_GLAPI void ZI_GLAPI_ENTRY glLoadMatrixf( const gl_float *m );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultMatrixd( const gl_double *m );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultMatrixf( const gl_float *m );
ZI_GLAPI void ZI_GLAPI_ENTRY glRotated( gl_double angle, gl_double x, gl_double y, gl_double z );
ZI_GLAPI void ZI_GLAPI_ENTRY glRotatef( gl_float angle, gl_float x, gl_float y, gl_float z );
ZI_GLAPI void ZI_GLAPI_ENTRY glScaled( gl_double x, gl_double y, gl_double z );
ZI_GLAPI void ZI_GLAPI_ENTRY glScalef( gl_float x, gl_float y, gl_float z );
ZI_GLAPI void ZI_GLAPI_ENTRY glTranslated( gl_double x, gl_double y, gl_double z );
ZI_GLAPI void ZI_GLAPI_ENTRY glTranslatef( gl_float x, gl_float y, gl_float z );

/*
 * Display Lists
 */
ZI_GLAPI gl_boolean ZI_GLAPI_ENTRY glIsList( gl_uint list );
ZI_GLAPI void ZI_GLAPI_ENTRY glDeleteLists( gl_uint list, gl_sizei range );
ZI_GLAPI gl_uint ZI_GLAPI_ENTRY glGenLists( gl_sizei range );
ZI_GLAPI void ZI_GLAPI_ENTRY glNewList( gl_uint list, gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glEndList( void );
ZI_GLAPI void ZI_GLAPI_ENTRY glCallList( gl_uint list );
ZI_GLAPI void ZI_GLAPI_ENTRY glCallLists( gl_sizei n, gl_enum type, const gl_void *lists );
ZI_GLAPI void ZI_GLAPI_ENTRY glListBase( gl_uint base );

/*
 * Drawing Functions
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glBegin( gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glEnd( void );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex2d( gl_double x, gl_double y );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex2f( gl_float x, gl_float y );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex2i( gl_int x, gl_int y );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex2s( gl_short x, gl_short y );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex3d( gl_double x, gl_double y, gl_double z );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex3f( gl_float x, gl_float y, gl_float z );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex3i( gl_int x, gl_int y, gl_int z );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex3s( gl_short x, gl_short y, gl_short z );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex4d( gl_double x, gl_double y, gl_double z, gl_double w );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex4f( gl_float x, gl_float y, gl_float z, gl_float w );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex4i( gl_int x, gl_int y, gl_int z, gl_int w );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex4s( gl_short x, gl_short y, gl_short z, gl_short w );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex2dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex2fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex2iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex2sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex3dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex3fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex3iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex3sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex4dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex4fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex4iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glVertex4sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3b( gl_byte nx, gl_byte ny, gl_byte nz );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3d( gl_double nx, gl_double ny, gl_double nz );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3f( gl_float nx, gl_float ny, gl_float nz );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3i( gl_int nx, gl_int ny, gl_int nz );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3s( gl_short nx, gl_short ny, gl_short nz );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3bv( const gl_byte *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormal3sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexd( gl_double c );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexf( gl_float c );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexi( gl_int c );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexs( gl_short c );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexdv( const gl_double *c );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexfv( const gl_float *c );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexiv( const gl_int *c );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexsv( const gl_short *c );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3b( gl_byte red, gl_byte green, gl_byte blue );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3d( gl_double red, gl_double green, gl_double blue );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3f( gl_float red, gl_float green, gl_float blue );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3i( gl_int red, gl_int green, gl_int blue );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3s( gl_short red, gl_short green, gl_short blue );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3ub( gl_ubyte red, gl_ubyte green, gl_ubyte blue );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3ui( gl_uint red, gl_uint green, gl_uint blue );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3us( gl_ushort red, gl_ushort green, gl_ushort blue );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4b( gl_byte red, gl_byte green, gl_byte blue, gl_byte alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4d( gl_double red, gl_double green, gl_double blue, gl_double alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4f( gl_float red, gl_float green, gl_float blue, gl_float alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4i( gl_int red, gl_int green, gl_int blue, gl_int alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4s( gl_short red, gl_short green, gl_short blue, gl_short alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4ub( gl_ubyte red, gl_ubyte green, gl_ubyte blue, gl_ubyte alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4ui( gl_uint red, gl_uint green, gl_uint blue, gl_uint alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4us( gl_ushort red, gl_ushort green, gl_ushort blue, gl_ushort alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3bv( const gl_byte *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3ubv( const gl_ubyte *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3uiv( const gl_uint *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor3usv( const gl_ushort *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4bv( const gl_byte *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4ubv( const gl_ubyte *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4uiv( const gl_uint *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glColor4usv( const gl_ushort *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord1d( gl_double s );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord1f( gl_float s );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord1i( gl_int s );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord1s( gl_short s );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord2d( gl_double s, gl_double t );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord2f( gl_float s, gl_float t );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord2i( gl_int s, gl_int t );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord2s( gl_short s, gl_short t );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord3d( gl_double s, gl_double t, gl_double r );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord3f( gl_float s, gl_float t, gl_float r );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord3i( gl_int s, gl_int t, gl_int r );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord3s( gl_short s, gl_short t, gl_short r );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord4d( gl_double s, gl_double t, gl_double r, gl_double q );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord4f( gl_float s, gl_float t, gl_float r, gl_float q );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord4i( gl_int s, gl_int t, gl_int r, gl_int q );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord4s( gl_short s, gl_short t, gl_short r, gl_short q );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord1dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord1fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord1iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord1sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord2dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord2fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord2iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord2sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord3dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord3fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord3iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord3sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord4dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord4fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord4iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoord4sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos2d( gl_double x, gl_double y );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos2f( gl_float x, gl_float y );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos2i( gl_int x, gl_int y );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos2s( gl_short x, gl_short y );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos3d( gl_double x, gl_double y, gl_double z );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos3f( gl_float x, gl_float y, gl_float z );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos3i( gl_int x, gl_int y, gl_int z );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos3s( gl_short x, gl_short y, gl_short z );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos4d( gl_double x, gl_double y, gl_double z, gl_double w );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos4f( gl_float x, gl_float y, gl_float z, gl_float w );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos4i( gl_int x, gl_int y, gl_int z, gl_int w );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos4s( gl_short x, gl_short y, gl_short z, gl_short w );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos2dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos2fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos2iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos2sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos3dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos3fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos3iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos3sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos4dv( const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos4fv( const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos4iv( const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRasterPos4sv( const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glRectd( gl_double x1, gl_double y1, gl_double x2, gl_double y2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glRectf( gl_float x1, gl_float y1, gl_float x2, gl_float y2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glRecti( gl_int x1, gl_int y1, gl_int x2, gl_int y2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glRects( gl_short x1, gl_short y1, gl_short x2, gl_short y2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glRectdv( const gl_double *v1, const gl_double *v2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glRectfv( const gl_float *v1, const gl_float *v2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glRectiv( const gl_int *v1, const gl_int *v2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glRectsv( const gl_short *v1, const gl_short *v2 );

/*
 * Lighting
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glShadeModel( gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glLightf( gl_enum light, gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glLighti( gl_enum light, gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glLightfv( gl_enum light, gl_enum pname, const gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glLightiv( gl_enum light, gl_enum pname, const gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetLightfv( gl_enum light, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetLightiv( gl_enum light, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glLightModelf( gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glLightModeli( gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glLightModelfv( gl_enum pname, const gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glLightModeliv( gl_enum pname, const gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glMaterialf( gl_enum face, gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glMateriali( gl_enum face, gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glMaterialfv( gl_enum face, gl_enum pname, const gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glMaterialiv( gl_enum face, gl_enum pname, const gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetMaterialfv( gl_enum face, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetMaterialiv( gl_enum face, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glColorMaterial( gl_enum face, gl_enum mode );


/*
 * Raster functions
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glPixelZoom( gl_float xfactor, gl_float yfactor );
ZI_GLAPI void ZI_GLAPI_ENTRY glPixelStoref( gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glPixelStorei( gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glPixelTransferf( gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glPixelTransferi( gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glPixelMapfv( gl_enum map, gl_sizei mapsize, const gl_float *values );
ZI_GLAPI void ZI_GLAPI_ENTRY glPixelMapuiv( gl_enum map, gl_sizei mapsize, const gl_uint *values );
ZI_GLAPI void ZI_GLAPI_ENTRY glPixelMapusv( gl_enum map, gl_sizei mapsize, const gl_ushort *values );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetPixelMapfv( gl_enum map, gl_float *values );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetPixelMapuiv( gl_enum map, gl_uint *values );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetPixelMapusv( gl_enum map, gl_ushort *values );
ZI_GLAPI void ZI_GLAPI_ENTRY glBitmap( gl_sizei width, gl_sizei height, gl_float xorig, gl_float yorig, gl_float xmove, gl_float ymove, const gl_ubyte *bitmap );
ZI_GLAPI void ZI_GLAPI_ENTRY glReadPixels( gl_int x, gl_int y, gl_sizei width, gl_sizei height, gl_enum format, gl_enum type, gl_void *pixels );
ZI_GLAPI void ZI_GLAPI_ENTRY glDrawPixels( gl_sizei width, gl_sizei height, gl_enum format, gl_enum type, const gl_void *pixels );
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyPixels( gl_int x, gl_int y, gl_sizei width, gl_sizei height, gl_enum type );

/*
 * Stenciling
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glStencilFunc( gl_enum func, gl_int ref, gl_uint mask );
ZI_GLAPI void ZI_GLAPI_ENTRY glStencilMask( gl_uint mask );
ZI_GLAPI void ZI_GLAPI_ENTRY glStencilOp( gl_enum fail, gl_enum zfail, gl_enum zpass );
ZI_GLAPI void ZI_GLAPI_ENTRY glClearStencil( gl_int s );

/*
 * Texture mapping
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glTexGend( gl_enum coord, gl_enum pname, gl_double param );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexGenf( gl_enum coord, gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexGeni( gl_enum coord, gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexGendv( gl_enum coord, gl_enum pname, const gl_double *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexGenfv( gl_enum coord, gl_enum pname, const gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexGeniv( gl_enum coord, gl_enum pname, const gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexGendv( gl_enum coord, gl_enum pname, gl_double *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexGenfv( gl_enum coord, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexGeniv( gl_enum coord, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexEnvf( gl_enum target, gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexEnvi( gl_enum target, gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexEnvfv( gl_enum target, gl_enum pname, const gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexEnviv( gl_enum target, gl_enum pname, const gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexEnvfv( gl_enum target, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexEnviv( gl_enum target, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexParameterf( gl_enum target, gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexParameteri( gl_enum target, gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexParameterfv( gl_enum target, gl_enum pname, const gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexParameteriv( gl_enum target, gl_enum pname, const gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexParameterfv( gl_enum target, gl_enum pname, gl_float *params);
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexParameteriv( gl_enum target, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexLevelParameterfv( gl_enum target, gl_int level, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexLevelParameteriv( gl_enum target, gl_int level, gl_enum pname, gl_int *params );

ZI_GLAPI void ZI_GLAPI_ENTRY glTexImage1D( gl_enum target, gl_int level, gl_int internalFormat, gl_sizei width, gl_int border, gl_enum format, gl_enum type, const gl_void *pixels );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexImage2D( gl_enum target, gl_int level, gl_int internalFormat, gl_sizei width, gl_sizei height, gl_int border, gl_enum format, gl_enum type, const gl_void *pixels );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetTexImage( gl_enum target, gl_int level, gl_enum format, gl_enum type, gl_void *pixels );

/*
 * Evaluators
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glMap1d( gl_enum target, gl_double u1, gl_double u2, gl_int stride, gl_int order, const gl_double *points );
ZI_GLAPI void ZI_GLAPI_ENTRY glMap1f( gl_enum target, gl_float u1, gl_float u2, gl_int stride, gl_int order, const gl_float *points );
ZI_GLAPI void ZI_GLAPI_ENTRY glMap2d( gl_enum target, gl_double u1, gl_double u2, gl_int ustride, gl_int uorder, gl_double v1, gl_double v2, gl_int vstride, gl_int vorder, const gl_double *points );
ZI_GLAPI void ZI_GLAPI_ENTRY glMap2f( gl_enum target, gl_float u1, gl_float u2, gl_int ustride, gl_int uorder, gl_float v1, gl_float v2, gl_int vstride, gl_int vorder, const gl_float *points );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetMapdv( gl_enum target, gl_enum query, gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetMapfv( gl_enum target, gl_enum query, gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetMapiv( gl_enum target, gl_enum query, gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalCoord1d( gl_double u );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalCoord1f( gl_float u );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalCoord1dv( const gl_double *u );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalCoord1fv( const gl_float *u );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalCoord2d( gl_double u, gl_double v );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalCoord2f( gl_float u, gl_float v );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalCoord2dv( const gl_double *u );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalCoord2fv( const gl_float *u );
ZI_GLAPI void ZI_GLAPI_ENTRY glMapGrid1d( gl_int un, gl_double u1, gl_double u2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glMapGrid1f( gl_int un, gl_float u1, gl_float u2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glMapGrid2d( gl_int un, gl_double u1, gl_double u2, gl_int vn, gl_double v1, gl_double v2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glMapGrid2f( gl_int un, gl_float u1, gl_float u2, gl_int vn, gl_float v1, gl_float v2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalPoint1( gl_int i );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalPoint2( gl_int i, gl_int j );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalMesh1( gl_enum mode, gl_int i1, gl_int i2 );
ZI_GLAPI void ZI_GLAPI_ENTRY glEvalMesh2( gl_enum mode, gl_int i1, gl_int i2, gl_int j1, gl_int j2 );

/*
 * Fog
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glFogf( gl_enum pname, gl_float param );
ZI_GLAPI void ZI_GLAPI_ENTRY glFogi( gl_enum pname, gl_int param );
ZI_GLAPI void ZI_GLAPI_ENTRY glFogfv( gl_enum pname, const gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glFogiv( gl_enum pname, const gl_int *params );

/*
 * Selection and Feedback
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glFeedbackBuffer( gl_sizei size, gl_enum type, gl_float *buffer );
ZI_GLAPI void ZI_GLAPI_ENTRY glPassThrough( gl_float token );
ZI_GLAPI void ZI_GLAPI_ENTRY glSelectBuffer( gl_sizei size, gl_uint *buffer );
ZI_GLAPI void ZI_GLAPI_ENTRY glInitNames( void );
ZI_GLAPI void ZI_GLAPI_ENTRY glLoadName( gl_uint name );
ZI_GLAPI void ZI_GLAPI_ENTRY glPushName( gl_uint name );
ZI_GLAPI void ZI_GLAPI_ENTRY glPopName( void );


} // namespace gl
} // namespace zi

#include <zi/gl/detail/gl_suffix.hpp>

#include <zi/gl/gl_1_1.hpp>
#include <zi/gl/gl_1_2.hpp>
#include <zi/gl/gl_1_3.hpp>
#include <zi/gl/gl_arb_imaging.hpp>

#endif
