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

#include <zi/cache/detail/key_extractors.hpp>
#include <zi/zunit/zunit.hpp>

ZiSUITE( ZiLib_Cache_Tests );

namespace cache_tests {

struct has_key_t
{
    typedef int key_t;
};

struct no_key_t
{
};


} // namespace cache_tests

ZiTEST( Test_KeyExtractors )
{
    /*

    using zi::cache::detail::has_key_t_checker;

    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t         >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t&        >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const   >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const & >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const volatile   >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const volatile & >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t          >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t&         >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const    >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const &  >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const volatile   >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const volatile&  >::value );


    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t *         >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t * &       >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const *   >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const * & >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const volatile *   >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const volatile * & >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t *          >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t * &        >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const *    >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const * &  >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const volatile *   >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const volatile * & >::value );

    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t [10]          >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t (&)[10]       >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const [10]    >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const (&)[10] >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const volatile [10]     >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const volatile (&) [10] >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t [10]          >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t (&)[10]       >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const [10]    >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const (&)[10] >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const volatile [10]     >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const volatile (&) [10] >::value );

    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t [10][10]          >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t (&)[10][10]       >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const [10][10]    >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const (&)[10][10] >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const volatile [10][10]     >::value );
    EXPECT_TRUE ( has_key_t_checker< cache_tests::has_key_t const volatile (&) [10][10] >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t [10][10]          >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t (&)[10][10]       >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const [10][10]    >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const (&)[10][10] >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const volatile [10][10]     >::value );
    EXPECT_FALSE( has_key_t_checker< cache_tests::no_key_t const volatile (&) [10][10] >::value );
    */

}
