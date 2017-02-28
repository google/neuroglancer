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

#ifndef ZI_CONCURRENCY_WIN32_DETAIL_PRIMITIVES_HPP
#define ZI_CONCURRENCY_WIN32_DETAIL_PRIMITIVES_HPP 1

#include <zi/concurrency/config.hpp>

namespace zi {
namespace concurrency_ {
namespace win32 {


typedef CRITICAL_SECTION critical_section;

using ::InitializeCriticalSection ;
using ::EnterCriticalSection      ;
using ::TryEnterCriticalSection   ;
using ::LeaveCriticalSection      ;
using ::DeleteCriticalSection     ;

typedef HANDLE   handle  ;
typedef DWORD    dword   ;
typedef LONGLONG longlong;

using ::CreateEvent;
using ::CreateMutex;
using ::CreateSemaphore;
using ::CreateThread;
using ::ReleaseMutex;
using ::ReleaseSemaphore;
using ::WaitForSingleObject;
using ::CloseHandle;
using ::GetCurrentThreadId;
using ::GetCurrentThread;
using ::SignalObjectAndWait;
using ::ResumeThread;
using ::SetEvent;
using ::ResetEvent;

using ::Sleep;

const unsigned forever = INFINITE;


} // namespace win32
} // namespace concurrency_
} // namespace zi

#endif
