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

#ifndef ZI_GL_GLU_HPP
#define ZI_GL_GLU_HPP 1

#include <zi/gl/detail/types.hpp>

#include <zi/gl/detail/gl_prefix.hpp>

class GLUnurbs;
class GLUquadric;
class GLUtesselator;

namespace zi {
namespace gl {

struct glu
{

    static const int ext_object_space_tess          = 1;
    static const int ext_nurbs_tessellator          = 1;

    static const int c_false                        = 0;
    static const int c_true                         = 1;

    static const int version_1_1                    = 1;
    static const int version_1_2                    = 1;
    static const int version_1_3                    = 1;

    static const int version                        = 100800;
    static const int extensions                     = 100801;

    static const int invalid_enum                   = 100900;
    static const int invalid_value                  = 100901;
    static const int out_of_memory                  = 100902;
    static const int incompatible_gl_version        = 100903;
    static const int invalid_operation              = 100904;

    static const int outline_polygon                = 100240;
    static const int outline_patch                  = 100241;

    static const int nurbs_error                    = 100103;
    static const int error                          = 100103;
    static const int nurbs_begin                    = 100164;
    static const int nurbs_begin_ext                = 100164;
    static const int nurbs_vertex                   = 100165;
    static const int nurbs_vertex_ext               = 100165;
    static const int nurbs_normal                   = 100166;
    static const int nurbs_normal_ext               = 100166;
    static const int nurbs_color                    = 100167;
    static const int nurbs_color_ext                = 100167;
    static const int nurbs_texture_coord            = 100168;
    static const int nurbs_tex_coord_ext            = 100168;
    static const int nurbs_end                      = 100169;
    static const int nurbs_end_ext                  = 100169;
    static const int nurbs_begin_data               = 100170;
    static const int nurbs_begin_data_ext           = 100170;
    static const int nurbs_vertex_data              = 100171;
    static const int nurbs_vertex_data_ext          = 100171;
    static const int nurbs_normal_data              = 100172;
    static const int nurbs_normal_data_ext          = 100172;
    static const int nurbs_color_data               = 100173;
    static const int nurbs_color_data_ext           = 100173;
    static const int nurbs_texture_coord_data       = 100174;
    static const int nurbs_tex_coord_data_ext       = 100174;
    static const int nurbs_end_data                 = 100175;
    static const int nurbs_end_data_ext             = 100175;

    static const int nurbs_error1                   = 100251;
    static const int nurbs_error2                   = 100252;
    static const int nurbs_error3                   = 100253;
    static const int nurbs_error4                   = 100254;
    static const int nurbs_error5                   = 100255;
    static const int nurbs_error6                   = 100256;
    static const int nurbs_error7                   = 100257;
    static const int nurbs_error8                   = 100258;
    static const int nurbs_error9                   = 100259;
    static const int nurbs_error10                  = 100260;
    static const int nurbs_error11                  = 100261;
    static const int nurbs_error12                  = 100262;
    static const int nurbs_error13                  = 100263;
    static const int nurbs_error14                  = 100264;
    static const int nurbs_error15                  = 100265;
    static const int nurbs_error16                  = 100266;
    static const int nurbs_error17                  = 100267;
    static const int nurbs_error18                  = 100268;
    static const int nurbs_error19                  = 100269;
    static const int nurbs_error20                  = 100270;
    static const int nurbs_error21                  = 100271;
    static const int nurbs_error22                  = 100272;
    static const int nurbs_error23                  = 100273;
    static const int nurbs_error24                  = 100274;
    static const int nurbs_error25                  = 100275;
    static const int nurbs_error26                  = 100276;
    static const int nurbs_error27                  = 100277;
    static const int nurbs_error28                  = 100278;
    static const int nurbs_error29                  = 100279;
    static const int nurbs_error30                  = 100280;
    static const int nurbs_error31                  = 100281;
    static const int nurbs_error32                  = 100282;
    static const int nurbs_error33                  = 100283;
    static const int nurbs_error34                  = 100284;
    static const int nurbs_error35                  = 100285;
    static const int nurbs_error36                  = 100286;
    static const int nurbs_error37                  = 100287;

    static const int auto_load_matrix               = 100200;
    static const int culling                        = 100201;
    static const int sampling_tolerance             = 100203;
    static const int display_mode                   = 100204;
    static const int parametric_tolerance           = 100202;
    static const int sampling_method                = 100205;
    static const int u_step                         = 100206;
    static const int v_step                         = 100207;
    static const int nurbs_mode                     = 100160;
    static const int nurbs_mode_ext                 = 100160;
    static const int nurbs_tessellator              = 100161;
    static const int nurbs_tessellator_ext          = 100161;
    static const int nurbs_renderer                 = 100162;
    static const int nurbs_renderer_ext             = 100162;

    static const int object_parametric_error        = 100208;
    static const int object_parametric_error_ext    = 100208;
    static const int object_path_length             = 100209;
    static const int object_path_length_ext         = 100209;
    static const int path_length                    = 100215;
    static const int parametric_error               = 100216;
    static const int domain_distance                = 100217;

    static const int map1_trim_2                    = 100210;
    static const int map1_trim_3                    = 100211;

    static const int point                          = 100010;
    static const int line                           = 100011;
    static const int fill                           = 100012;
    static const int silhouette                     = 100013;

    static const int smooth                         = 100000;
    static const int flat                           = 100001;
    static const int none                           = 100002;

    static const int outside                        = 100020;
    static const int inside                         = 100021;

    static const int tess_begin                     = 100100;
    static const int begin                          = 100100;
    static const int tess_vertex                    = 100101;
    static const int vertex                         = 100101;
    static const int tess_end                       = 100102;
    static const int end                            = 100102;
    static const int tess_error                     = 100103;
    static const int tess_edge_flag                 = 100104;
    static const int edge_flag                      = 100104;
    static const int tess_combine                   = 100105;
    static const int tess_begin_data                = 100106;
    static const int tess_vertex_data               = 100107;
    static const int tess_end_data                  = 100108;
    static const int tess_error_data                = 100109;
    static const int tess_edge_flag_data            = 100110;
    static const int tess_combine_data              = 100111;

    static const int cw                             = 100120;
    static const int ccw                            = 100121;
    static const int interior                       = 100122;
    static const int exterior                       = 100123;
    static const int unknown                        = 100124;

    static const int tess_winding_rule              = 100140;
    static const int tess_boundary_only             = 100141;
    static const int tess_tolerance                 = 100142;

    static const int tess_error1                    = 100151;
    static const int tess_error2                    = 100152;
    static const int tess_error3                    = 100153;
    static const int tess_error4                    = 100154;
    static const int tess_error5                    = 100155;
    static const int tess_error6                    = 100156;
    static const int tess_error7                    = 100157;
    static const int tess_error8                    = 100158;
    static const int tess_missing_begin_polygon     = 100151;
    static const int tess_missing_begin_contour     = 100152;
    static const int tess_missing_end_polygon       = 100153;
    static const int tess_missing_end_contour       = 100154;
    static const int tess_coord_too_large           = 100155;
    static const int tess_need_combine_callback     = 100156;

    static const int tess_winding_odd               = 100130;
    static const int tess_winding_nonzero           = 100131;
    static const int tess_winding_positive          = 100132;
    static const int tess_winding_negative          = 100133;
    static const int tess_winding_abs_geq_two       = 100134;

    static const double tess_max_coord              = 1.0e150;

    typedef ::GLUnurbs      nurbs_obj;
    typedef ::GLUquadric    quadric_obj;
    typedef ::GLUtesselator tesselator_obj;
    typedef ::GLUtesselator triangulator_obj;

};

} // namespace gl

using gl::glu;

} // namespace zi

namespace zi {
namespace gl {

//typedef void (GLAPIENTRYP _GLUfuncptr)();

ZI_GLAPI void ZI_GLAPI_ENTRY gluBeginCurve (::GLUnurbs* nurb);
ZI_GLAPI void ZI_GLAPI_ENTRY gluBeginPolygon (::GLUtesselator* tess);
ZI_GLAPI void ZI_GLAPI_ENTRY gluBeginSurface (::GLUnurbs* nurb);
ZI_GLAPI void ZI_GLAPI_ENTRY gluBeginTrim (::GLUnurbs* nurb);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluBuild1DMipmapLevels (gl_enum target, gl_int internalFormat, gl_sizei width, gl_enum format, gl_enum type, gl_int level, gl_int base, gl_int max, const void *data);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluBuild1DMipmaps (gl_enum target, gl_int internalFormat, gl_sizei width, gl_enum format, gl_enum type, const void *data);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluBuild2DMipmapLevels (gl_enum target, gl_int internalFormat, gl_sizei width, gl_sizei height, gl_enum format, gl_enum type, gl_int level, gl_int base, gl_int max, const void *data);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluBuild2DMipmaps (gl_enum target, gl_int internalFormat, gl_sizei width, gl_sizei height, gl_enum format, gl_enum type, const void *data);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluBuild3DMipmapLevels (gl_enum target, gl_int internalFormat, gl_sizei width, gl_sizei height, gl_sizei depth, gl_enum format, gl_enum type, gl_int level, gl_int base, gl_int max, const void *data);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluBuild3DMipmaps (gl_enum target, gl_int internalFormat, gl_sizei width, gl_sizei height, gl_sizei depth, gl_enum format, gl_enum type, const void *data);
ZI_GLAPI gl_boolean ZI_GLAPI_ENTRY gluCheckExtension (const gl_ubyte *extName, const gl_ubyte *extString);
ZI_GLAPI void ZI_GLAPI_ENTRY gluCylinder (::GLUquadric* quad, gl_double base, gl_double top, gl_double height, gl_int slices, gl_int stacks);
ZI_GLAPI void ZI_GLAPI_ENTRY gluDeleteNurbsRenderer (::GLUnurbs* nurb);
ZI_GLAPI void ZI_GLAPI_ENTRY gluDeleteQuadric (::GLUquadric* quad);
ZI_GLAPI void ZI_GLAPI_ENTRY gluDeleteTess (::GLUtesselator* tess);
ZI_GLAPI void ZI_GLAPI_ENTRY gluDisk (::GLUquadric* quad, gl_double inner, gl_double outer, gl_int slices, gl_int loops);
ZI_GLAPI void ZI_GLAPI_ENTRY gluEndCurve (::GLUnurbs* nurb);
ZI_GLAPI void ZI_GLAPI_ENTRY gluEndPolygon (::GLUtesselator* tess);
ZI_GLAPI void ZI_GLAPI_ENTRY gluEndSurface (::GLUnurbs* nurb);
ZI_GLAPI void ZI_GLAPI_ENTRY gluEndTrim (::GLUnurbs* nurb);
ZI_GLAPI const gl_ubyte * ZI_GLAPI_ENTRY gluErrorString (gl_enum error);
ZI_GLAPI void ZI_GLAPI_ENTRY gluGetNurbsProperty (::GLUnurbs* nurb, gl_enum property, gl_float* data);
ZI_GLAPI const gl_ubyte * ZI_GLAPI_ENTRY gluGetString (gl_enum name);
ZI_GLAPI void ZI_GLAPI_ENTRY gluGetTessProperty (::GLUtesselator* tess, gl_enum which, gl_double* data);
ZI_GLAPI void ZI_GLAPI_ENTRY gluLoadSamplingMatrices (::GLUnurbs* nurb, const gl_float *model, const gl_float *perspective, const gl_int *view);
ZI_GLAPI void ZI_GLAPI_ENTRY gluLookAt (gl_double eyeX, gl_double eyeY, gl_double eyeZ, gl_double centerX, gl_double centerY, gl_double centerZ, gl_double upX, gl_double upY, gl_double upZ);
ZI_GLAPI ::GLUnurbs* ZI_GLAPI_ENTRY gluNewNurbsRenderer (void);
ZI_GLAPI ::GLUquadric* ZI_GLAPI_ENTRY gluNewQuadric (void);
ZI_GLAPI ::GLUtesselator* ZI_GLAPI_ENTRY gluNewTess (void);
ZI_GLAPI void ZI_GLAPI_ENTRY gluNextContour (::GLUtesselator* tess, gl_enum type);
//ZI_GLAPI void ZI_GLAPI_ENTRY gluNurbsCallback (::GLUnurbs* nurb, gl_enum which, _::GLUfuncptr CallBackFunc);
ZI_GLAPI void ZI_GLAPI_ENTRY gluNurbsCallbackData (::GLUnurbs* nurb, gl_void* userData);
ZI_GLAPI void ZI_GLAPI_ENTRY gluNurbsCallbackDataEXT (::GLUnurbs* nurb, gl_void* userData);
ZI_GLAPI void ZI_GLAPI_ENTRY gluNurbsCurve (::GLUnurbs* nurb, gl_int knotCount, gl_float *knots, gl_int stride, gl_float *control, gl_int order, gl_enum type);
ZI_GLAPI void ZI_GLAPI_ENTRY gluNurbsProperty (::GLUnurbs* nurb, gl_enum property, gl_float value);
ZI_GLAPI void ZI_GLAPI_ENTRY gluNurbsSurface (::GLUnurbs* nurb, gl_int sKnotCount, gl_float* sKnots, gl_int tKnotCount, gl_float* tKnots, gl_int sStride, gl_int tStride, gl_float* control, gl_int sOrder, gl_int tOrder, gl_enum type);
ZI_GLAPI void ZI_GLAPI_ENTRY gluOrtho2D (gl_double left, gl_double right, gl_double bottom, gl_double top);
ZI_GLAPI void ZI_GLAPI_ENTRY gluPartialDisk (::GLUquadric* quad, gl_double inner, gl_double outer, gl_int slices, gl_int loops, gl_double start, gl_double sweep);
ZI_GLAPI void ZI_GLAPI_ENTRY gluPerspective (gl_double fovy, gl_double aspect, gl_double zNear, gl_double zFar);
ZI_GLAPI void ZI_GLAPI_ENTRY gluPickMatrix (gl_double x, gl_double y, gl_double delX, gl_double delY, gl_int *viewport);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluProject (gl_double objX, gl_double objY, gl_double objZ, const gl_double *model, const gl_double *proj, const gl_int *view, gl_double* winX, gl_double* winY, gl_double* winZ);
ZI_GLAPI void ZI_GLAPI_ENTRY gluPwlCurve (::GLUnurbs* nurb, gl_int count, gl_float* data, gl_int stride, gl_enum type);
//ZI_GLAPI void ZI_GLAPI_ENTRY gluQuadricCallback (::GLUquadric* quad, gl_enum which, _::GLUfuncptr CallBackFunc);
ZI_GLAPI void ZI_GLAPI_ENTRY gluQuadricDrawStyle (::GLUquadric* quad, gl_enum draw);
ZI_GLAPI void ZI_GLAPI_ENTRY gluQuadricNormals (::GLUquadric* quad, gl_enum normal);
ZI_GLAPI void ZI_GLAPI_ENTRY gluQuadricOrientation (::GLUquadric* quad, gl_enum orientation);
ZI_GLAPI void ZI_GLAPI_ENTRY gluQuadricTexture (::GLUquadric* quad, gl_boolean texture);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluScaleImage (gl_enum format, gl_sizei wIn, gl_sizei hIn, gl_enum typeIn, const void *dataIn, gl_sizei wOut, gl_sizei hOut, gl_enum typeOut, gl_void* dataOut);
ZI_GLAPI void ZI_GLAPI_ENTRY gluSphere (::GLUquadric* quad, gl_double radius, gl_int slices, gl_int stacks);
ZI_GLAPI void ZI_GLAPI_ENTRY gluTessBeginContour (::GLUtesselator* tess);
ZI_GLAPI void ZI_GLAPI_ENTRY gluTessBeginPolygon (::GLUtesselator* tess, gl_void* data);
//ZI_GLAPI void ZI_GLAPI_ENTRY gluTessCallback (::GLUtesselator* tess, gl_enum which, _::GLUfuncptr CallBackFunc);
ZI_GLAPI void ZI_GLAPI_ENTRY gluTessEndContour (::GLUtesselator* tess);
ZI_GLAPI void ZI_GLAPI_ENTRY gluTessEndPolygon (::GLUtesselator* tess);
ZI_GLAPI void ZI_GLAPI_ENTRY gluTessNormal (::GLUtesselator* tess, gl_double valueX, gl_double valueY, gl_double valueZ);
ZI_GLAPI void ZI_GLAPI_ENTRY gluTessProperty (::GLUtesselator* tess, gl_enum which, gl_double data);
ZI_GLAPI void ZI_GLAPI_ENTRY gluTessVertex (::GLUtesselator* tess, gl_double *location, gl_void* data);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluUnProject (gl_double winX, gl_double winY, gl_double winZ, const gl_double *model, const gl_double *proj, const gl_int *view, gl_double* objX, gl_double* objY, gl_double* objZ);
ZI_GLAPI gl_int ZI_GLAPI_ENTRY gluUnProject4 (gl_double winX, gl_double winY, gl_double winZ, gl_double clipW, const gl_double *model, const gl_double *proj, const gl_int *view, gl_double nearVal, gl_double farVal, gl_double* objX, gl_double* objY, gl_double* objZ, gl_double* objW);

} // namespace gl
} // namespace zi

#include <zi/gl/detail/gl_suffix.hpp>

#endif
