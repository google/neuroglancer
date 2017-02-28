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

#ifndef ZI_ZUNIT_EXPECT_XXX_HPP
#define ZI_ZUNIT_EXPECT_XXX_HPP 1

#include <zi/zunit/config.hpp>
#include <zi/zunit/checker.hpp>
#include <zi/zunit/exception.hpp>

#include <exception>

#define ZI_UNIT_DEFINE_UNARY_EXPECT_MACRO( op, v )                      \
    do                                                                  \
    {                                                                   \
        ::zi::zunit::op ## _checker ___c( v );                          \
                                                                        \
        if ( ___c )                                                     \
        {                                                               \
            ++this->passed_;                                            \
        }                                                               \
        else                                                            \
        {                                                               \
            throw ::zi::zunit::unary_check_exception                    \
                ( "EXPECT_" #op, #v, ___c.value_, ___c.type_,           \
                  this, __LINE__ );                                     \
        }                                                               \
    } while( 0 )

#define EXPECT_TRUE( v )  ZI_UNIT_DEFINE_UNARY_EXPECT_MACRO( TRUE,  v )
#define EXPECT_FALSE( v ) ZI_UNIT_DEFINE_UNARY_EXPECT_MACRO( FALSE, v )

#define ZI_UNIT_DEFINE_BINARY_EXPECT_MACRO( op, l, r )  \
    do                                                  \
    {                                                   \
        ::zi::zunit::op ## _checker ___c( l, r );       \
        if (___c)                                       \
        {                                               \
            ++this->passed_;                            \
        }                                               \
        else                                            \
        {                                               \
            throw ::zi::zunit::binary_check_exception   \
                ( "EXPECT_" #op, #l, #r,                \
                  ___c.lvalue_, ___c.rvalue_,           \
                  ___c.ltype_ , ___c.rtype_,            \
                  this, __LINE__ );                     \
        }                                               \
    } while( 0 )

#define EXPECT_EQ( l, r )  ZI_UNIT_DEFINE_BINARY_EXPECT_MACRO( EQ,  l, r )
#define EXPECT_NEQ( l, r ) ZI_UNIT_DEFINE_BINARY_EXPECT_MACRO( NEQ, l, r )
#define EXPECT_LT( l, r )  ZI_UNIT_DEFINE_BINARY_EXPECT_MACRO( LT,  l, r )
#define EXPECT_LTE( l, r ) ZI_UNIT_DEFINE_BINARY_EXPECT_MACRO( LTE, l, r )
#define EXPECT_GT( l, r )  ZI_UNIT_DEFINE_BINARY_EXPECT_MACRO( GT,  l, r )
#define EXPECT_GTE( l, r ) ZI_UNIT_DEFINE_BINARY_EXPECT_MACRO( GTE, l, r )
#define EXPECT_OR( l, r )  ZI_UNIT_DEFINE_BINARY_EXPECT_MACRO( OR,  l, r )

#define ZI_EXPECT_THROW_XXX( v, e )                                     \
    {                                                                   \
        bool ___ok = false;                                             \
        try                                                             \
        {                                                               \
            (void)( v );                                                \
        }                                                               \
        catch ( e &exc )                                                \
        {                                                               \
            ___ok = true;                                               \
        }                                                               \
        catch ( ::zi::zunit::choose_exception< e >::type &exc )         \
        {                                                               \
            throw ::zi::zunit::throw_check_exception                    \
                ( "EXPECT_THROW", exc.what(), #v, #e, this, __LINE__ ); \
        }                                                               \
        catch ( ... )                                                   \
        {                                                               \
            throw ::zi::zunit::throw_check_exception                    \
                ( "EXPECT_THROW", "Unknown exception",                  \
                  #v, #e, this, __LINE__ );                             \
        }                                                               \
                                                                        \
        if ( !___ok )                                                   \
        {                                                               \
            throw ::zi::zunit::throw_check_exception                    \
                ( "EXPECT_THROW", "", #v, #e, this, __LINE__ );         \
        }                                                               \
    }                                                                   \
        ++this->passed_

#define ZI_EXPECT_THROW_ANY(v)                                  \
    {                                                           \
        bool ___ok = false;                                     \
        try                                                     \
        {                                                       \
            (void)( v );                                        \
        }                                                       \
        catch ( ... )                                           \
        {                                                       \
            ___ok = true;                                       \
        }                                                       \
                                                                \
        if ( !___ok )                                           \
        {                                                       \
            throw ::zi::zunit::throw_check_exception            \
                ( "EXPECT_THROW", "", #v, 0, this, __LINE__ );  \
        }                                                       \
    }                                                           \
        ++this->passed_

#define ZI_EXPECT_THROW_3( x,... ) ZI_EXPECT_THROW_XXX( __VA_ARGS__ )
#define ZI_EXPECT_THROW_2( f,... ) ZI_EXPECT_THROW_##f( __VA_ARGS__ )
#define ZI_EXPECT_THROW_1( x,... ) ZI_EXPECT_THROW_2( __VA_ARGS__ )
#define ZI_EXPECT_THROW_0( x,... ) ZI_EXPECT_THROW_1( __VA_ARGS__ )

#define EXPECT_THROW( v,... )                                           \
    ZI_EXPECT_THROW_0( ~, ##__VA_ARGS__, 3, ANY, v, ##__VA_ARGS__ )

#endif
