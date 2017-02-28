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

#include <zi/concurrency/concurrency.hpp>
#include <zi/zlog/sink.hpp>
#include <zi/zlog/logs.hpp>
#include <zi/zunit/zunit.hpp>

#include <sstream>
#include <string>

ZiSUITE( ZiLib_ZiLog_Tests );

ZiTEST( Test_Sink )
{

    std::stringstream ss;
    std::string       s ;

    zi::zlog::sink    sink_( ss );

    zi::zlog::token_wrapper( sink_ ).get() << "A" << 1 << "C";
    ss >> s >> s;
    EXPECT_EQ( s, std::string( "A" ) );

    ss >> s;
    EXPECT_EQ( s, std::string( "1" ) );

    ss >> s;
    EXPECT_EQ( s, std::string( "C" ) );

    std::stringstream ss3;
    zi::zlog::sink    sink3_( ss3 );

    zi::zlog::token_wrapper( sink3_ ).get() << sink3_;
    ss3 >> s >> s;
    EXPECT_EQ( s[0], '<' );
    ss3 >> s;
    EXPECT_EQ( s, std::string( "zi::zlog::sink" ) );

}
